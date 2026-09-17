# tg-abreviator — Design Record

Telegram bot that summarizes a group chat, or answers questions about it, over a
user-selected range of messages.

This document is the **decision record**. Every entry here was settled
deliberately; if you want to change one, change it here first. `docs/PLAN.md`
turns this into parallel work packages.

---

## 1. Hard constraints (Telegram Bot API)

These are not design choices. They are the shape of the problem.

| Constraint | Consequence |
| --- | --- |
| There is **no history read** in the Bot API. No `getChatHistory`, no `getMessages`. `getUserPersonalChatMessages` only covers a user's private chat with the bot. | The bot can only summarize messages **it witnessed and persisted itself**. There is no backfill, ever. |
| **Privacy mode is on by default.** A bot in a group receives only `/commands`, replies to its own messages, and service messages. Disabling it requires BotFather **and re-adding the bot**. A bot that is a group admin receives everything regardless. | Privacy mode must be **off** (or the bot made admin), or there is no corpus. |
| **No "message deleted" update exists.** `message` and `edited_message` arrive; deletions do not. | The TTL *is* the deletion story. Say so publicly rather than pretending otherwise. |
| Undelivered updates are kept **24 hours maximum**. `getUpdates` and webhooks are mutually exclusive. | Downtime beyond 24h is permanent data loss. Gaps must be detected and disclosed. |
| Two processes polling one token get **409 Conflict**. | Exactly one instance. Enforced by lockfile. |
| Forum supergroups carry `message_thread_id`; `sendMessage` also takes it. Omitting it posts to General. | Ranges are thread-scoped; replies must echo `message_thread_id`. |
| `sendMessage` text is 1–4096 chars. ~1 msg/s per chat, ~20/min per group, ~30/s global; `429` carries `parameters.retry_after`. | Output length cap, splitting fallback, throttled sends. |
| `sendChatAction` lasts **5 seconds or less**. | Long operations use a placeholder message + `editMessageText`, not typing indicators. |
| A bot **cannot initiate a DM** with a user who never `/start`ed it (`403`). | DM delivery always needs an in-chat fallback. |

---

## 2. User-facing contract

Invocation is **always an explicit command**. The command name is configurable
(`/tldr` by default). Nothing else in the chat is ever a trigger — the bot sees
every message, so implicit triggering would fire on ordinary conversation.

Arguments are `[range-token] [free-text question]`. **Only the leading token is
parsed as a range.** Everything after it is the question, verbatim.

### Range × intent are orthogonal

| Input | Range | Intent |
| --- | --- | --- |
| `/tldr` (as a reply) | since the replied-to message (inclusive) | summarize |
| `/tldr <question>` (as a reply) | since the replied-to message | answer |
| `/tldr 2h` | last 2 hours | summarize |
| `/tldr -50` | last 50 messages | summarize |
| `/tldr -50 <question>` | last 50 messages | answer |
| `/tldr` (no reply, no args) | last 2 days, capped at 500 messages | summarize |
| `/tldr all 2h` | cross-topic, last 2 hours | summarize |

### Range token grammar

- **Bare negative number** (`-50`) = message count. No unit needed.
- **Positive number must carry a unit** (`2h`, `30m`, `3d`, `1w`, `2026-09-15`).
  Bare `50` is an error with a help hint.
- **Sign is ignored when a unit is present**: `-2h` == `2h`.
- **Natural-language time words are parsed deterministically** from a PL+EN
  lexicon (`wczoraj`, `dzisiaj`, `w ostatnim tygodniu`, `yesterday`, `last week`).
  Extensible to more languages. **The LLM is never used to parse a range.**
- Unparseable leading token → error + `help`, never a guess.
- Explicit range **wins** over a reply anchor when both are present; the header
  states which was used.
- Range end is always *now*.
- Defaults when no range given: **2 days, capped at 500 messages**.
- `-N` counts stored human messages only — not the bot's own output, not service
  messages. Hard-capped at 500.

### Scope

- Ranges are **thread-scoped** in forums (`message_thread_id`), with `all` as an
  escape hatch. Replies echo the invoking thread.
- If the reply anchor lives in a different topic than the invocation, follow the
  **anchor's** thread; answer in the topic the user is standing in.
- Every answer carries a header stating the resolved scope:
  `Topic: Deploys · last 2h · 43 messages`. A wrong guess must be visible.

### Commands

| Command | Tier | Effect |
| --- | --- | --- |
| `/tldr …` | member | the above |
| `/tldr help` | member | grammar reference |
| `/forgetme` | member | erase own rows + opt out of future logging |
| `/privacy` | member | what is stored, TTL, operator contact, how to erase |
| `/forget` | chat admin | wipe the whole chat log |
| `/tldr tz <IANA>` | chat admin | set chat timezone |
| `/tldr model <alias>` | chat admin | set chat model |
| `/tldr dm on\|off` | member | per-user delivery preference |
| `/tldr stats` | chat admin (own chat) / operator (global) | usage + cost |

**TTL is operator-only** and lives in the config file. A group admin extending
retention would be doing it to *other people's* messages.

### Permission tiers

`operator` (`OPERATOR_USER_IDS`, anything anywhere) > `chat admin`
(`getChatMember` → `creator`/`administrator`) > `member`. One `requireTier()`
guard, tested.

---

## 3. Architecture

```
Telegram ──long polling──> Ingester ──> SQLite (messages, chunks, settings, usage)
                                           │
Command ──> Permissions ──> Range parser ──┤
                                           ▼
                                   Corpus assembly
                                           │
                              (over threshold? map-reduce)
                                           ▼
                            LLM port ──> registry/router ──> provider
                                           ▼
                                 Structured output
                                           ▼
                        Render (HTML allowlist) ──> Delivery (throttled)
```

- **Long polling**, not webhooks: no public URL, no TLS termination, and the
  persisted `offset` is crash recovery for free. Kept behind an interface so
  webhook is a swap.
- **Single instance.** Lockfile + `PRAGMA journal_mode=WAL`, `busy_timeout=5000`,
  `synchronous=NORMAL`, `foreign_keys=ON`. Known scaling path if ever needed:
  1 ingester + N workers + Postgres + a job queue — **not** N identical
  containers, because Telegram permits only one poller.
- **Node 26** (native `Temporal`, unflagged), TypeScript, grammY,
  `@anthropic-ai/sdk` behind a provider port.
- Docker, with the SQLite file on a **host bind mount** (not a named volume).
  Set `user:` in compose and pre-create the directory — uid/gid mismatch is the
  classic failure. Never NFS: WAL over NFS corrupts. A documented no-Docker path
  must also work.

---

## 4. Data model

```
messages(chat_id, message_id, thread_id, user_id, display_name, ts,
         reply_to_message_id, kind, text)
   PK (chat_id, message_id)         -- upsert on conflict; replayed updates are idempotent
   INDEX (chat_id, thread_id, message_id)
   kind: text | photo | sticker | voice | ... | gap_marker | redacted

chunks(chat_id, thread_id, first_msg_id, last_msg_id, model, prompt_version,
       text, created_at)
   -- compacted summaries. TTL = TTL of its newest covered message.

chat_settings(chat_id, tz, model_alias, updated_by, updated_at)
user_prefs(chat_id, user_id, dm_delivery)
opt_outs(chat_id, user_id)
poll_state(last_update_id, last_seen_at)
usage_events(id, ts, chat_id, thread_id, user_id, model, phase,
             input_tokens, output_tokens, cost_micros, unit_prices_json,
             range_spec, question_hash, status)
```

Notes:

- **Media**: store the caption and a `kind` placeholder. Never the file. A
  summary can say "Ola sent a photo" without you hosting anyone's pictures.
- **Edits** update the row in place — otherwise you summarize retracted claims.
- **Gap markers** are real rows. On startup, if `now - last_seen_at` exceeds a
  threshold, insert one. Any range overlapping a gap gets an explicit line in
  the output. Silent holes destroy trust faster than missing features.
- `usage_events` is a **per-call event log**, which is a richer personal-data
  artifact than a daily rollup. Therefore: store only the question *hash*, never
  the text; give it the **same TTL as messages**; derive long-lived stats from
  periodic aggregate rollups carrying no `user_id`.
- `unit_prices_json` is stored per row so editing the config price table does not
  silently rewrite last month's history.

---

## 5. Privacy and retention

The bot builds a durable transcript of a chat that believes itself ephemeral.
That is the whole product, so the controls have to be real.

- **Chat allowlist.** Anywhere not in the allowlist: reply "not authorised",
  `leaveChat`, **store nothing**. This is the single biggest risk reducer — it
  keeps the bot out of strangers' groups.
- **Rolling TTL.** Global default 30d, per-chat override in config, **hard cap**
  in env. Nothing can set "forever" without a redeploy.
- **Chunk TTL = TTL of the chunk's newest covered message.** A cached summary
  must never outlive the messages it summarizes.
- **`/forgetme`** deletes that user's rows, sets an opt-out flag so future
  messages are never stored, and **deletes every chunk whose `[first,last]`
  range overlaps** a deleted message. Coarse, cheap, correct. Without the chunk
  invalidation, erasure is theatre.
- Opted-out users are stored as **nothing at all** — not even a placeholder. A
  placeholder is still their data. Cost: their absence leaves holes in
  summaries. Accepted.
- **Anonymisation in `usage_events`** replaces `user_id` with a **freshly
  generated random token**, stored nowhere else. *Not* a hash of the user id —
  Telegram user ids are a small enumerable integer space, so a deterministic
  hash is re-linkable and therefore not erasure. Display pseudonyms for
  non-erased users, if wanted, are a separate HMAC-over-a-server-secret
  mechanism.
- **Join announcement** + `/privacy` carry the operator contact. Data export
  requests are handled manually by the operator.
- Whoever can read the DB can read every group the bot is in. Disk encryption,
  and never log row contents.

---

## 6. Safety

Every message fed to the model is written by someone who may be hostile, and the
*question* is untrusted too — any group member can invoke the bot.

### Code-enforced (hard guarantees)

1. **Never cross chats.** `chat_id` is a required first argument on every
   repository method. A leak here is the worst failure this bot can have; make
   it structurally impossible rather than remembered.
2. **Secret redaction at ingest.** API-key / token / IBAN / card / long-digit
   shapes are stored as `[redacted]`. The DB should not hold them either.
3. **Opt-out filtering at query time**, not in the prompt.
4. **Bot's own messages are excluded from the corpus** — otherwise a poisoned
   summary feeds the next summary and the injection outlives the original
   message.
5. **Output rendering**: HTML with a strict allowlist (`<b>`, `<i>`, `<code>`),
   everything else escaped; `tg://` links stripped; `@` mentions neutralised;
   link previews off. (MarkdownV2 is rejected: it requires escaping
   ``_ * [ ] ( ) ~ ` > # + - = | { } . !`` and model output will break it or be
   steered by it.)
6. **Slur substitution** via a configurable PL+EN wordlist applied to rendered
   output — a regex, not a prompt rule, so it is testable. The model separately
   emits a `tone` field; a heated exchange still gets a `⚠️` in the header.
   Baby-talk the words, keep the temperature honest.
7. **Structured output** (`output_config.format`) with fixed fields, so there is
   no free-text channel for "output this instead" and no way to leak the system
   prompt.
8. **Permanent footer**: `🤖 AI summary — may be wrong`, in the chat's language.

### Prompt-enforced (judgment)

9. **Never attribute a claim unsupported by the message.** The #1 real failure:
   *"if I have to do this again I'm quitting lol"* becoming *"Ola is quitting."*
   Prefer short verbatim fragments over paraphrase for anything attributed to a
   named person; hedge when tone is ambiguous.
10. **Never surface special-category disclosures** (health, sexuality, religion,
    politics, finances, relationships). Report that a topic came up, never the
    disclosure. A passing remark should not become a durable artifact.
11. **Never repeat slurs or abuse verbatim** — describe, don't quote.
12. **Never carry forward retracted content.** Deletions are invisible, but
    "sorry, wrong chat" / "usuńcie to" is not.
13. **Never assert absence as fact.** "I don't see a decision in this range" —
    not "nobody decided anything." The corpus has holes by construction.

### Product line

Targeted retrieval about a person (`what did Marek say about X?`) is the
feature and is allowed. **Open-ended profiling** ("summarise everything X has
ever said", "what kind of person is X") is refused. That is the line between a
summarizer and a dossier.

---

## 7. LLM layer

- **Default `claude-sonnet-5`**, per-chat override.
- **Provider/model registry in config** with an ordered `[{when, use}]` routing
  rule list, first match wins, plus a default. A small rule list, not a DSL.
- **Map phase uses a cheap model (`claude-haiku-4-5`), reduce phase the strong
  one.** This is the actual point of multi-model here.
- **Price table per model** lives in config (input/output/cache-read $/MTok) —
  hardcoding it makes the stats worthless the day prices change.
- **API keys are env-only**, referenced from config by name
  (`apiKeyEnv: ANTHROPIC_API_KEY`). Never the key itself; this repo is public.
- **Token counting via `messages.count_tokens`**, never `tiktoken` and never an
  estimate. Polish tokenizes worse than English and the difference matters.
- **No prompt caching in v1.** Caching is prefix-match and the transcript — the
  volatile part — is ~95% of the tokens, so naive caching buys nothing. (The
  real version, a per-chat append-only transcript prefix with the breakpoint at
  the end, means sending the whole window every call. Revisit only when the
  usage stats show the bill justifies it.)
- **Never silently truncate.** Over the threshold, warn and compact.

### Compaction (map-reduce)

**One threshold applied recursively at every level.** Concatenate; if over
`COMPACT_THRESHOLD`, split and summarize each part; repeat on the results. Not
two separate thresholds — compaction is roughly 20:1, so a second, higher
threshold for the recursion step would be unreachable dead code.

Note `claude-sonnet-5` has a 1M context window: the threshold is a **cost and
attention** knob, not a fit constraint.

**Chunk boundaries must be deterministic** or the cache never hits and two calls
a minute apart produce differently-shaped summaries. **Hybrid bucketing**: time
buckets (6h, in the chat's timezone) subdivided deterministically by count when
a bucket exceeds the token threshold. Time buckets also fall on natural
conversational seams (overnight gaps), which makes summaries read better.

Chunk cache key includes `model` and `prompt_version`, or you serve summaries
from a prompt you have since fixed.

### Over-budget behaviour

Warn first and suggest a narrower range; compact when the user proceeds. A
`MAX_INPUT_TOKENS` ceiling is checked with `count_tokens` before every call —
one 10,000-character message can blow a 500-message budget by itself.

---

## 8. Delivery

- **Placeholder + edit**, not typing indicators: send `⏳ Czytam 430 wiadomości…`
  immediately, `editMessageText` with the result. Survives past 5s, acts as a
  receipt, and carries map-reduce progress (`kompaktuję 3/7`) — **throttled to
  ~1 edit / 3s**, since edits count against the same 20/min group budget.
- **The reduce step is instructed to stay under ~3000 characters.** Splitting is
  a safety net, not the normal path: split on paragraph boundaries, never inside
  an HTML tag, 2–3 parts maximum.
- **In-chat by default** — transparency is a feature, because everyone can see
  what the bot claimed and correct it. Per-user `/tldr dm on` opt-in; on `403`,
  fall back in-chat with *"nie mogę wysłać prywatnie — napisz do mnie
  `/start`"* rather than dropping the answer.
- grammY's throttler/transformer plugin, and `429 retry_after` is authoritative:
  sleep exactly that long.

---

## 9. Guards

| Guard | Rule |
| --- | --- |
| Per-user cooldown | 1 call / 60s, in-memory, replies with remaining seconds |
| Concurrency | 1 in-flight per chat; also prevents two map-reduce jobs racing on the same chunks |
| Dedupe | identical request within ~5 min returns the previous answer, marked `↺ odpowiedź sprzed N min` |
| Daily caps | per-chat call count **and** a global USD budget; when the budget trips the bot refuses everything until midnight. This is the only control that bounds actual liability — a hard stop, not a warning. |

### Dedupe identity — exact match, deliberately

```
normalize = trim → NFC → collapse whitespace → toLocaleLowerCase('pl') → strip trailing ?!.
key = sha256(chat_id ‖ thread_id ‖ raw_range_token ‖ normalized_question ‖ model ‖ prompt_version)
```

Not cosine similarity. A **false positive** (cached answer to a different
question) is a silently wrong answer; a **false negative** costs ~$0.08. The
errors are not symmetric, so bias hard toward exact. And the case dedupe exists
for — "I don't think it heard me, let me re-send" — is byte-identical by nature;
a rephrase means the user wants a different answer.

`NFC` matters: Polish diacritics arrive composed or decomposed depending on the
keyboard, so the same word from two devices can be different byte strings.

Key on the **raw range token**, not the resolved window — `/tldr 2h` twice three
minutes apart resolves to different windows and would never hit. The cached
answer is therefore up to 5 minutes stale, which is the point, so it is labelled.

---

## 10. Configuration

Three layers, resolved in this order: **DB chat override → config per-chat
section → config default → built-in default.** One resolver function, tested.

| Layer | Holds | Changed by |
| --- | --- | --- |
| **env** | `BOT_TOKEN`, provider API keys, `DATABASE_PATH`, `OPERATOR_USER_IDS`, TTL hard cap | redeploy |
| **config.yaml** (in git, no secrets) | model registry, routing rules, price table, thresholds, caps, command name, allowlist, slur wordlist, per-chat TTL, defaults | edit + restart |
| **SQLite** | per-chat tz / model, per-user DM pref, opt-outs | bot commands, live |

- **YAML**, because routing rules are nested and need comments explaining *why* a
  rule exists.
- **Zod validation at boot, fail fast.** Specifically: every model referenced by
  a routing rule exists in the registry; every registry entry's `apiKeyEnv` is
  actually set; every model in the price table exists. A typo should kill the
  process at startup with a readable message, not surface as a 400 at 2am.
- **No hot reload.** Config changes mean a restart. Per-chat settings are live
  precisely because they are in the DB.
- Ship `config.example.yaml` with every knob documented inline; the loader
  deep-merges user config over built-in defaults so a minimal config is 5 lines.

---

## 11. Quality

You cannot unit-test a summarizer, and it fails *invisibly* — inventing a
decision nobody made, reading a joke as a plan, missing the one message that
mattered.

**v1 ships:**

- An eval **harness** (fixture loader, runner, output diff against the previous
  `prompt_version`).
- **Adversarial fixtures**, hand-written and synthetic — they need no real data:
  sarcasm (`"I'm quitting lol"`), a prompt-injection attempt, a retracted
  message, a window containing a gap marker, and a thread where nothing was
  decided (does it say so, or invent one?).
- **👍/👎 inline keyboard** on every answer, logged with `prompt_version` and
  `model`. Requires `callback_query` in `allowed_updates` and an
  `answerCallbackQuery` on every press, or the client spins.

**Deferred:** real-window fixtures with hand-written ground truth, once the
ingester has been running long enough to have a corpus. No LLM-as-judge scoring —
with a handful of fixtures you read them yourself in three minutes and learn
more than a number would tell you.

---

## 12. Non-goals

- **No backfill.** Not via MTProto, not via a user account. The Bot API cannot
  read history and a user-account login's blast radius (every chat that account
  is in, a phone number, a session file) is not worth retroactive summaries.
- **No public multi-tenant deployment** in v1. The allowlist is the boundary.
- **No prompt caching** in v1 — see §7.
- **No horizontal scaling.** Telegram permits one poller.
- **No LLM-based range parsing.**
