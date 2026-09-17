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

## 3. Architecture — ports and adapters

The domain here is small and the I/O around it is large and hostile: Telegram, an
LLM provider, SQLite, a config file, an error sink. That ratio is what hexagonal
architecture is for.

```
src/domain/        pure. No I/O, no framework types, no clock, no randomness.
src/application/   use cases + port interfaces (driving and driven)
src/adapters/      one directory per external system
src/bootstrap/     composition root — the only place that knows all of them
```

### What lives in the domain

- **Range grammar** — `parse()` and `resolve()` (`RangeSpec` → `ResolvedRange`)
- **Bucketing** — deterministic time+count chunk boundaries
- **Dedupe key** — normalization and hashing
- **Corpus assembly** and transcript formatting
- **Output rules** — HTML allowlist escaping, slur substitution, splitting
- **Permission tiers**
- **Cost arithmetic** from tokens + unit prices

None of these need a database, a network, or a Telegram type. Nearly every rule
in §6 marked *code-enforced* is a pure function — that is precisely why it can be
a guarantee rather than a hope.

### Driven ports (domain calls out)

| Port | Purpose |
| --- | --- |
| `MessageStore`, `ChunkStore`, `SettingsStore`, `UsageStore`, `OptOutStore`, `PollStateStore` | persistence |
| `ChatGateway` | send / edit / getMember / leave / typing / answerCallback |
| `Llm` | `complete(request) -> {structured, usage}` |
| `Config` | typed read of resolved configuration |
| `ErrorReporter` | `capture(error, context)` |
| `Clock` | `now() -> Temporal.Instant` |
| `IdGenerator` | random token for anonymisation |

`Clock` and `IdGenerator` are **ports, not imports**. TTL expiry, bucket
boundaries, dedupe windows and anonymisation tokens all depend on them, and all
of them need to be deterministic under test.

### Driving ports (outside calls in)

`SummarizeRange`, `AnswerQuestion`, `IngestMessage`, `ForgetUser`, `PurgeChat`,
`UpdateChatSetting`, `ReadUsage`.

### Adapters

| Adapter | Implements |
| --- | --- |
| `inbound/telegram` | grammY poller + command dispatcher → driving ports |
| `outbound/sqlite` | the six stores, via better-sqlite3 |
| `outbound/anthropic` | `Llm`, via `@anthropic-ai/sdk` |
| `outbound/telegram` | `ChatGateway`, via grammY |
| `outbound/config` | `Config`, via `config-layers` (§10) |
| `outbound/glitchtip` | `ErrorReporter`, via the Sentry SDK (§11) |
| `outbound/system` | `Clock`, `IdGenerator` |

### The rule that keeps this honest

**No grammY type, no Anthropic SDK type, no better-sqlite3 type and no
config-layers type may appear in `src/domain` or `src/application`.** A Telegram
`Message` becomes a `StoredMessage` at the adapter boundary, and nothing
downstream knows Telegram exists.

This is the rule that erodes first in every hexagonal codebase, usually via one
innocent `import type`. So it is enforced mechanically, not by discipline:
**eslint import boundaries failing CI**. `domain` imports only `domain`;
`application` imports `domain`; `adapters` import `application` and `domain`;
only `bootstrap` imports everything.

### Runtime

- **Long polling**, not webhooks: no public URL, no TLS termination, and the
  persisted `offset` is crash recovery for free. It lives behind the inbound
  adapter, so webhook support is a second adapter rather than a rewrite.
- **Single instance**, enforced by lockfile. `PRAGMA journal_mode=WAL`,
  `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`. Known scaling
  path: 1 ingester + N workers + Postgres + a queue — **not** N identical
  containers, because Telegram permits one poller.
- **Node 26** (native `Temporal`, unflagged), TypeScript, grammY.
- Docker, SQLite on a **host bind mount** (not a named volume). Set `user:` in
  compose and pre-create the directory — uid/gid mismatch is the classic
  failure. Never NFS: WAL over NFS corrupts. A no-Docker path must also work.

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
- **The error sink is a second exfiltration path** and is governed by the same
  rule: nothing that would be deleted by the TTL or by `/forgetme` may ever
  reach it. See §11.

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

## 10. Configuration — `config-layers`

Configuration uses [`config-layers`](https://github.com/mt3o/config-layers)
(`config-layers@^0.4.0` on npm), behind the `Config` port so the domain never
imports it.

**Layers, lowest priority first:**

| # | Layer | Holds | Changed by |
| --- | --- | --- | --- |
| 1 | `defaults` | built-in, in code | a release |
| 2 | `file` | `config.yaml` — model registry, routing rules, price table, thresholds, caps, command name, allowlist, slur wordlist, per-chat TTL | edit + restart |
| 3 | `env` | `BOT_TOKEN`, provider API keys, `DATABASE_PATH`, `OPERATOR_USER_IDS`, TTL hard cap, `GLITCHTIP_DSN` | redeploy |
| 4 | `chat` | per-chat tz / model, from SQLite | bot commands, live |

Layers 1–3 are built once at boot with `LayeredConfig.fromLayersAsync`.

**Per-chat overrides use `__derive`:**
`cfg.__derive({ name: 'chat', config: settingsRow })`. That replaces the
hand-rolled precedence resolver entirely — derive is exactly the mechanism the
library exists for. Derived configs are **cached per `chat_id`** and invalidated
when a settings command writes, so a Proxy is not constructed per request.

### Validation stays ours

`config-layers` deliberately does not validate at runtime — it relies on static
types, which an untyped YAML file bypasses completely. So the boot sequence is:

1. Parse `config.yaml`.
2. **Zod-validate each layer's shape** *before* handing it to `fromLayers`.
3. Build the layered config.
4. **Cross-validate the resolved snapshot**: every model referenced by a routing
   rule exists in the registry; every registry entry's `apiKeyEnv` is actually
   set; every priced model exists.
5. Fail fast with a readable message.

Step 4 cannot be a per-layer check — a routing rule in the file may legitimately
name a model defined in `defaults`. It has to run against the resolved view.

### What the library buys beyond merging

`__inspect(key)` reports **which layer supplied a value**. That becomes an
operator-only `/tldr config <key>`, answering *"why is this chat on Haiku?"* —
which is otherwise a genuinely irritating thing to debug across four layers.

### Constraints it imposes

- `__inspect`, `__derive`, `get` and `getAll` are **reserved**; no config key may
  use those names.
- The resolved config is frozen. Nothing mutates config at runtime — a settings
  change writes to SQLite and produces a new derived config.
- **No hot reload** of the file; restart. Chat settings are live precisely
  because they are a DB-backed layer.
- Secrets live in the `env` layer only, referenced from the file by name
  (`apiKeyEnv: ANTHROPIC_API_KEY`). `config.yaml` is in git.
- Ship `config.example.yaml` with every knob documented inline; `defaults` means
  a minimal user config is five lines, not two hundred.

---

## 11. Observability — GlitchTip

GlitchTip is Sentry-compatible, so `@sentry/node` points at a GlitchTip DSN,
behind the `ErrorReporter` port. A **no-op adapter** is used when
`GLITCHTIP_DSN` is unset, so a contributor without a DSN still gets a working
bot and tests never emit.

Projects follow the convention already in the org (`punktomat-dev` /
`-preprod` / `-prod`, `ytshield-preprod` / `-prod`): **`tg-abreviator-dev`** and
**`tg-abreviator-prod`**, platform `node`. DSN per environment.

### This punches a hole in §5 unless it is scrubbed

An error sink receives whatever is attached to the exception — and the natural
things to attach here are message text, the user's question, display names and
user ids. All of that would **leave the TTL, leave `/forgetme`'s reach, and land
on a third-party server**. It is the exact laundering path §5 was written to
close, arriving through the back door.

So scrubbing is part of the feature, not hardening to add later:

- `sendDefaultPii: false`.
- A **`beforeSend` hook that drops `event.extra` and `event.contexts` wholesale**
  and permits only an explicit tag allowlist. Allowlist, never blocklist — a
  blocklist fails open the first time someone adds a field.
- **Never attach** message text, question text, display names, or rendered
  output. Attach shapes and identifiers: message counts, token counts, range
  spec, model, `prompt_version`, pipeline phase.
- `chat_id` and `user_id` go as **HMAC'd short tags**, not raw, so the error
  stream is not a membership list. Stable within a deployment, so operators can
  still correlate.
- **Disable console and HTTP-body breadcrumbs.** Console breadcrumbs will
  cheerfully capture the transcript you logged three lines earlier.
- Errors that carry user content *in their own message* are the dangerous case —
  a provider 400 echoing the prompt, a SQLite error quoting a row. Wrap them:
  report a redacted error type plus a local correlation id, and keep the full
  text in local logs only.

### What is worth reporting

**Report:** unhandled exceptions; provider errors after retries; Telegram 5xx and
unexpected 4xx; config validation failure at boot; TTL sweeper failure; lockfile
contention; budget-cap trips.

**Do not report:** `429` with `retry_after`, `403` on a DM attempt, or a user
typing a bad range token. Those are expected and handled — they are metrics, not
incidents, and reporting them trains you to ignore the inbox.

Tag every event with `release` (git SHA), `environment`, and `prompt_version`.

---

## 12. Quality

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

## 13. Non-goals

- **No backfill.** Not via MTProto, not via a user account. The Bot API cannot
  read history and a user-account login's blast radius (every chat that account
  is in, a phone number, a session file) is not worth retroactive summaries.
- **No public multi-tenant deployment** in v1. The allowlist is the boundary.
- **No prompt caching** in v1 — see §7.
- **No horizontal scaling.** Telegram permits one poller.
- **No LLM-based range parsing.**
