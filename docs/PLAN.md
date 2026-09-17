# tg-abreviator — Parallel Implementation Plan

Companion to `docs/DESIGN.md`, which is the authority on *what* is being built.
This document is about *how to build it with many agents at once without them
colliding*.

---

## 0. Rules for parallel agents

These exist because the failure mode of parallel agents is not bad code, it is
**merge conflicts and contract drift**.

1. **Contracts are frozen after Phase 0.** Types, repository interfaces, the LLM
   port, the config schema and the SQL schema are written once, by one agent,
   before anyone else starts. Nobody edits them afterwards without stopping the
   world.
2. **Every workstream owns a disjoint set of files.** The file-ownership table
   in each card is exhaustive. An agent that needs to change a file it does not
   own **stops and reports** instead of editing it.
3. **No shared mutable files.** `package.json`, `tsconfig.json`, `vitest.config.ts`
   and the SQL schema are written in Phase 0 and are **read-only** thereafter.
   Phase 0 declares *every* dependency the whole project will need, so no
   workstream ever adds one.
4. **No barrel files.** No `src/index.ts` re-exporting everything — that is a
   guaranteed conflict. Each module exports from its own entry point; the
   integrator wires them.
5. **Everyone builds against fakes.** Phase 0 ships in-memory implementations of
   every interface. WS3 does not wait for WS1's SQLite; WS5 does not wait for
   WS4's real Anthropic client.
6. **Tests are part of the deliverable, not a follow-up.** A workstream is not
   done until its tests pass against the fakes.
7. **One branch per workstream**, named `ws/<id>-<slug>`, off the integration
   branch. Small PRs, merged by the integrator in wave order.

---

## Phase 0 — Contracts (serial, one agent, blocks everything)

No business logic. Interfaces, types, fakes, and project scaffolding only.

**Deliverables**

```
package.json              # Node 26, TS, vitest, grammy, @anthropic-ai/sdk,
                          # better-sqlite3, zod, yaml, pino  — ALL deps, final
tsconfig.json             # strict: true, ES2024+, NodeNext
vitest.config.ts
.editorconfig / eslint / prettier
src/types/domain.ts       # StoredMessage, MessageKind, RangeSpec, ResolvedRange,
                          # Scope, Intent, Answer, Chunk, UsageEvent, Tier
src/types/errors.ts       # typed error taxonomy (ParseError, OverBudgetError,
                          # NotAuthorisedError, HorizonError, …)
src/db/repos/*.interface.ts     # MessageRepo, ChunkRepo, SettingsRepo,
                                # UsageRepo, OptOutRepo, PollStateRepo
src/db/repos/memory/*.ts        # in-memory fakes of all of the above
src/db/schema.sql               # tables + indexes exactly as DESIGN.md §4
src/llm/port.ts                 # LlmPort: complete(req) -> {structured, usage}
src/llm/providers/fake.ts       # scripted fake provider for tests
src/telegram/api.interface.ts   # TelegramApi (send, edit, getChatMember,
                                # leaveChat, sendChatAction, answerCallbackQuery)
src/telegram/api.fake.ts        # recording fake
src/config/schema.ts            # full Zod schema for config.yaml
config.example.yaml             # every knob, documented inline
```

**Critical contract decisions to encode**

- `MessageRepo` methods take `chatId` as a **required first parameter**, always.
  This is the structural guarantee against cross-chat leaks (DESIGN §6.1).
- `RangeSpec` (what the user typed) and `ResolvedRange` (what it resolved to) are
  **distinct types**. Dedupe keys on the former; queries use the latter.
- `LlmPort.complete()` returns `usage` (input/output tokens + model) on **every**
  call, including map-phase calls, so `usage_events` never has to guess.
- Repos expose `countInRange()` separately from `fetchRange()` so guards can
  check size before materialising anything.

**Definition of done:** `npm test` runs green with zero real implementations —
the fakes and their round-trip tests are the only thing exercised.

---

## Wave 1 — Parallel (7 workstreams, no interdependencies)

All seven start simultaneously once Phase 0 merges.

---

### WS1 — Persistence

| | |
| --- | --- |
| **Owns** | `src/db/sqlite/**`, `src/db/migrations/**`, `src/db/lock.ts`, `src/db/sweeper.ts` |
| **Depends on** | Phase 0 interfaces + `schema.sql` |

Real `better-sqlite3` implementations of every repo interface. Migration runner
(forward-only, numbered). `PRAGMA journal_mode=WAL`, `busy_timeout=5000`,
`synchronous=NORMAL`, `foreign_keys=ON`. Lockfile via `flock` so a second
instance exits loudly. TTL sweeper: deletes expired messages, expired
`usage_events`, and **chunks whose newest covered message has expired**.

**Must implement exactly:** the `/forgetme` cascade — delete the user's messages,
insert the opt-out row, delete every chunk whose `[first_msg_id, last_msg_id]`
**overlaps** any deleted message, and replace `user_id` in `usage_events` with a
**freshly generated random UUID** (not a hash — DESIGN §5).

**DoD:** every interface test from Phase 0 passes against SQLite as well as the
fake. Plus: a cascade test proving no chunk survives a `/forgetme` that touches
its range; a concurrency test proving the lockfile rejects a second process.

---

### WS2 — Ingester

| | |
| --- | --- |
| **Owns** | `src/telegram/poller.ts`, `src/ingest/**` |
| **Depends on** | Phase 0 (`MessageRepo`, `PollStateRepo`, `TelegramApi`) |

Long polling with persisted `offset`. Allowlist check → unknown chat gets "not
authorised" + `leaveChat` + **stores nothing**. Update → `StoredMessage` mapping
(`thread_id`, `reply_to_message_id`, media → `kind` + caption only, never the
file). `edited_message` updates in place. Upsert on `(chat_id, message_id)`.
Secret redaction at ingest (API keys, tokens, IBAN, card, long digit runs →
`[redacted]`). Opt-out filter: store nothing at all, not a placeholder. Gap
detection on startup → `gap_marker` row. Join announcement.

**DoD:** table-driven tests over recorded `Update` JSON fixtures, run entirely
against the memory repo and fake API. Explicit cases: forum vs non-forum,
edit-in-place, replayed update is idempotent, opted-out user leaves no trace,
startup gap inserts exactly one marker.

---

### WS3 — Range parser

| | |
| --- | --- |
| **Owns** | `src/range/**` |
| **Depends on** | Phase 0 types only — **pure functions, zero I/O** |

`parse(argString) -> {rangeSpec, question}` and
`resolve(rangeSpec, ctx) -> ResolvedRange`. Leading-token-only grammar. Bare
negative = message count; positive **requires** a unit; sign ignored when a unit
is present; bare positive → typed error carrying a help hint. PL+EN lexicon in
separate files with a registration shape that makes a third language additive.
`Temporal` with the chat's IANA timezone; DST-correct (a `3d` range across the
October change is 73 hours). `all` keyword. **No LLM anywhere in this module.**

**DoD:** the most heavily tested module in the repo. Table-driven over the whole
grammar including: `-50`, `50` (error), `2h`, `-2h`, `1w`, `2026-09-15`,
`wczoraj`, `w ostatnim tygodniu`, `yesterday`, `last week`, `all 2h`,
`2h co ustalili?`, `co ustalili wczoraj?` (→ default range, "wczoraj" stays in
the question), reply-anchor + explicit range (explicit wins), DST boundaries,
and unknown-token errors.

---

### WS4 — LLM layer

| | |
| --- | --- |
| **Owns** | `src/llm/registry.ts`, `src/llm/router.ts`, `src/llm/providers/anthropic.ts`, `src/llm/prompts/**`, `src/llm/tokens.ts` |
| **Depends on** | Phase 0 `LlmPort` + config schema |

Anthropic implementation of `LlmPort` using `@anthropic-ai/sdk`. Registry built
from config; keys resolved from `apiKeyEnv`, never inline. Ordered
`[{when, use}]` router, first match wins, plus default. Token counting via
`messages.count_tokens`. Structured output schemas (`summary`, `key_points[]`,
`unanswered[]`, `tone`). System prompts carrying DESIGN §6 rules 9–13, versioned
with an explicit `prompt_version` constant.

**Prompt structure is a hard requirement:** instructions live **only** in the
system prompt; transcript and question go in a `user` turn inside delimited
`<transcript>` / `<question>` blocks declared as untrusted data. Never
concatenate either into the system prompt.

**DoD:** router table tests; a test asserting a routing rule naming an unknown
model fails Zod validation at load; a test asserting no user-supplied string can
reach the system prompt.

---

### WS5 — Render & delivery

| | |
| --- | --- |
| **Owns** | `src/render/**`, `src/telegram/deliver.ts`, `src/telegram/throttle.ts` |
| **Depends on** | Phase 0 `TelegramApi` + `Answer` type |

HTML rendering with a strict `<b>/<i>/<code>` allowlist, everything else escaped.
Strip `tg://`, neutralise `@` mentions, link previews off. Slur substitution from
the configurable PL+EN wordlist. Header (scope, counts, cached marker, `⚠️` on
heated tone, gap disclosure). Permanent footer. Placeholder + `editMessageText`,
edits throttled to ~1/3s. Splitting fallback: paragraph boundaries, never inside
a tag, 2–3 parts max. DM preference with `403` fallback. grammY throttler;
`429 retry_after` honoured exactly.

**DoD:** fuzz the escaper with hostile model output (unbalanced tags, `tg://`
links, `@everyone`, 20K characters) and assert the result is always valid
Telegram HTML under 4096 chars per part. A split must never land inside a tag.

---

### WS6 — Commands & permissions

| | |
| --- | --- |
| **Owns** | `src/commands/**`, `src/permissions.ts` |
| **Depends on** | Phase 0 repos + `TelegramApi` |

Command dispatcher with a **configurable command name**, `@botname` suffix
stripping, and `bot_command` entity at offset 0 as the only trigger. Three-tier
`requireTier()` guard (operator / chat admin via `getChatMember` / member).
Implements `help`, `privacy`, `forgetme`, `forget`, `tz`, `model`, `dm`, `stats`.
`/tldr` itself is dispatched to a handler interface that WS7 fills in.

**DoD:** tier matrix test — every command × every tier, asserting allow/deny.
A test proving nothing but an explicit command triggers the bot (feed it 100
ordinary messages including `-5 stopni jutro` and `since yesterday`, assert zero
invocations).

---

### WS7 — Ops & packaging

| | |
| --- | --- |
| **Owns** | `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `README.md`, `.github/workflows/**`, `scripts/**` |
| **Depends on** | Phase 0 `package.json` only |

Node 26 image. Compose with the SQLite file on a **host bind mount**, explicit
`user:`, pre-created directory. Documented no-Docker path. README covering:
BotFather setup (**privacy mode off, then re-add the bot to the group** — this is
the step everyone misses and without it there is no corpus), the single-instance
constraint and why (Telegram `409`), the bind-mount uid/gid trap, never-NFS, the
env var list, and the known scaling path. CI: typecheck, lint, test.

**DoD:** `docker compose up` on a clean checkout reaches a running process that
fails with a *readable* config error rather than a stack trace.

---

## Wave 2 — Parallel (starts when Wave 1 merges)

---

### WS8 — Pipeline: corpus + single-shot

| | |
| --- | --- |
| **Owns** | `src/pipeline/corpus.ts`, `src/pipeline/summarize.ts`, `src/pipeline/answer.ts` |
| **Depends on** | WS1 (repos), WS3 (`ResolvedRange`), WS4 (`LlmPort`) |

Corpus assembly from a `ResolvedRange`: thread scoping, bot's own messages
excluded, opt-outs filtered, gap markers surfaced as an explicit disclosure,
formatting as `[HH:MM] Name: text`. Anchor older than the horizon → clamp and
say so. `count_tokens` check against `MAX_INPUT_TOKENS` **before** the call.
Under threshold → single call. Over → hand off to WS9 after warning the user.

**DoD:** a corpus containing an opted-out user, a gap marker, a media
placeholder, and a cross-topic anchor renders correctly and deterministically.

---

### WS9 — Pipeline: map-reduce & chunk cache

| | |
| --- | --- |
| **Owns** | `src/pipeline/compact.ts`, `src/pipeline/buckets.ts`, `src/pipeline/chunkcache.ts` |
| **Depends on** | WS1 (`ChunkRepo`), WS4 (`LlmPort`), WS8 (corpus format) |

**Hybrid bucketing**: 6h time buckets in the chat's timezone, deterministically
subdivided by count when over the token threshold. **One threshold applied
recursively**: concatenate, if over `COMPACT_THRESHOLD` split and summarize each
part, repeat — not two separate thresholds. Map phase uses the cheap model, reduce
the strong one. Chunk cache keyed including `model` and `prompt_version`.
Progress reported through the WS5 placeholder at ~1 edit / 3s.

**DoD:** **determinism test** — the same range computed twice, with a new message
arriving in between, produces the same bucket boundaries for all completed
buckets. A recursion test reaching depth 3 on a synthetic 2M-token corpus using
the fake provider. A cache test proving a `prompt_version` bump misses.

---

### WS10 — Guards & stats

| | |
| --- | --- |
| **Owns** | `src/guards/**`, `src/stats/**` |
| **Depends on** | WS1 (`UsageRepo`) |

Per-user cooldown, per-chat concurrency of 1, dedupe (normalize → NFC →
collapse → `toLocaleLowerCase('pl')` → strip trailing punctuation → sha256 over
`chat ‖ thread ‖ raw range token ‖ question ‖ model ‖ prompt_version`, 5-minute
TTL, result labelled as cached), per-chat daily call cap, **global USD budget as
a hard stop**. `usage_events` writer storing `unit_prices_json` per row and the
question **hash** only. Aggregate rollup job. `/tldr stats` rendering.

**DoD:** dedupe normalization tests including decomposed-vs-composed Polish
diacritics. A budget test proving the hard stop actually refuses. A test proving
the dedupe key uses the **raw** range token, not the resolved window.

---

### WS11 — Eval harness & fixtures

| | |
| --- | --- |
| **Owns** | `eval/**` |
| **Depends on** | WS4 (prompts, `LlmPort`) |

Fixture loader, runner, and output diff against the previous `prompt_version`.
Hand-written **synthetic adversarial fixtures** — these need no real chat data:
sarcasm (`"if I have to do this again I'm quitting lol"` must not become "X is
quitting"), a prompt-injection attempt, a retracted message (`"sorry, wrong
chat"`), a window containing a gap marker, and a thread where nothing was
decided (must say so rather than invent one). Real-window fixtures come later,
once the ingester has a corpus; leave a documented slot for them.

**DoD:** `npm run eval` produces a readable per-fixture diff. Each adversarial
fixture has a written expectation of what a *correct* answer must and must not
contain.

---

## Wave 3 — Integration (serial, one agent)

| | |
| --- | --- |
| **Owns** | `src/main.ts`, `src/wiring.ts`, `src/config/load.ts`, `src/config/resolve.ts` |

Composition root. Config loading with **Zod validation at boot, failing fast**:
every routed model exists in the registry, every `apiKeyEnv` is actually set,
every priced model exists. The four-layer settings resolver (DB chat override →
config per-chat → config default → built-in). Wire every workstream. Graceful
shutdown: finish the in-flight poll, flush, release the lock.

**DoD:** end-to-end test against the fake Telegram API and fake provider —
`/tldr -50 co ustalili?` in a forum topic produces a correctly scoped, correctly
rendered, correctly billed answer.

---

## Milestone gates

| Gate | Contains | Ship? |
| --- | --- | --- |
| **M1 — ingester live** | Phase 0 + WS1 + WS2 + WS6(`privacy`/`forgetme`/`forget`) + WS7 | **Deploy immediately.** No LLM dependency, no cost, and it starts accumulating the corpus everything else needs — including the real eval fixtures. It is also the only component whose bugs are *unrecoverable*: an unlogged message is gone forever. Let it bake. |
| **M2 — `/tldr` works** | + WS3 + WS4 + WS5 + WS8 + Wave 3 | Internal |
| **M3 — v1** | + WS9 + WS10 + WS11 | Ship |

While M1 is live and the rest is being built, `/tldr` replies
*"jeszcze się uczę — mam 340 wiadomości od 17.09"* rather than staying silent, so
the group knows the bot is alive and exactly what it has.

---

## Dependency graph

```
Phase 0 ─┬─> WS1 persistence ──┬─> WS8 corpus+single-shot ─┬─> Wave 3 integration
         ├─> WS2 ingester ─────┤                           │
         ├─> WS3 range parser ─┤   WS9 map-reduce ──────────┤
         ├─> WS4 llm ──────────┴─> WS10 guards+stats ───────┤
         ├─> WS5 render                WS11 eval ───────────┘
         ├─> WS6 commands
         └─> WS7 ops
```

Seven agents in Wave 1, four in Wave 2. The only serial points are Phase 0 and
Wave 3 — and Phase 0 is short, because it contains no logic.

---

## Standing instructions for every workstream agent

> Read `docs/DESIGN.md` in full before writing code. It is the authority; this
> plan only says who builds what.
>
> You own exactly the files listed in your card. Do not edit any other file —
> not `package.json`, not the shared types, not another workstream's module. If
> you believe you need to, stop and report why.
>
> Build against the in-memory fakes from Phase 0. Do not wait for, or reach into,
> another workstream's real implementation.
>
> Tests ship with the code. Your workstream is not done until `npm test` passes.
>
> Where `DESIGN.md` states a rule as "never", it is a hard constraint, not a
> default — in particular: never cross `chat_id`; never let user-supplied text
> reach a system prompt; never use an LLM to parse a range; never let a cached
> chunk outlive the messages it covers; never silently truncate a corpus.
