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
package.json            # Node 26, TS, vitest, grammy, @anthropic-ai/sdk,
                        # better-sqlite3, config-layers, @sentry/node, zod,
                        # yaml, pino, eslint-plugin-boundaries — ALL deps, final
tsconfig.json           # strict, ES2024+, NodeNext
vitest.config.ts
eslint.config.js        # + import-boundary rules (see below) — CI-enforced
src/domain/**           # entities, value objects, typed error taxonomy.
                        #   StoredMessage, MessageKind, RangeSpec, ResolvedRange,
                        #   Scope, Intent, Answer, Chunk, UsageEvent, Tier
src/application/ports/  # ALL driven + driving port interfaces (DESIGN §3)
test/fakes/**           # in-memory implementations of every driven port:
                        #   stores, ChatGateway, Llm, Config, ErrorReporter,
                        #   Clock (settable), IdGenerator (seeded)
src/adapters/outbound/sqlite/schema.sql
config.example.yaml     # every knob, documented inline
src/config/schema.ts    # Zod schemas, per-layer + resolved cross-check
```

**Critical contract decisions to encode**

- Store methods take `chatId` as a **required first parameter**, always. This is
  the structural guarantee against cross-chat leaks (DESIGN §6.1).
- `RangeSpec` (what the user typed) and `ResolvedRange` (what it resolved to) are
  **distinct types**. Dedupe keys on the former; queries use the latter.
- `Llm.complete()` returns `usage` on **every** call, map-phase included, so
  `usage_events` never has to guess.
- Stores expose `countInRange()` separately from `fetchRange()`, so guards can
  check size before materialising anything.
- `Clock` and `IdGenerator` are ports. The fakes are settable and seeded — TTL,
  bucketing, dedupe windows and anonymisation are all time- or
  randomness-dependent and must be deterministic under test.
- `ErrorReporter.capture()` takes `(error, context)` where `context` is a
  **closed, typed tag set** — not `Record<string, unknown>`. The type system is
  the first line of the §11 scrubbing rule; the `beforeSend` allowlist is the
  second.

**Import-boundary rules (eslint, failing CI)**

```
domain      → domain only
application → domain
adapters    → application, domain
bootstrap   → anything
```

No grammY, Anthropic SDK, better-sqlite3, Sentry or config-layers type may
appear in `domain` or `application` (DESIGN §3). Ship a deliberately-failing
fixture proving the rule fires.

**Definition of done:** `npm test` runs green with zero real implementations —
the fakes and their round-trip tests are the only thing exercised.

---

## Wave 1 — Parallel (9 workstreams, no interdependencies)

All nine start simultaneously once Phase 0 merges. Every one of them builds
against the Phase 0 fakes.

---

### WS1 — SQLite adapter

| | |
| --- | --- |
| **Owns** | `src/adapters/outbound/sqlite/**`, `src/adapters/outbound/sqlite/migrations/**` |
| **Implements** | the six store ports |

Real `better-sqlite3` implementations. Forward-only numbered migrations.
`PRAGMA journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`,
`foreign_keys=ON`. Lockfile via `flock` so a second instance exits loudly. TTL
sweeper deleting expired messages, expired `usage_events`, and **chunks whose
newest covered message has expired**.

**Must implement exactly:** the `/forgetme` cascade — delete the user's messages,
insert the opt-out row, delete every chunk whose `[first_msg_id, last_msg_id]`
**overlaps** a deleted message, and replace `user_id` in `usage_events` with a
**freshly generated random token from `IdGenerator`** (not a hash — DESIGN §5).

**DoD:** the Phase 0 port-conformance suite passes against SQLite exactly as it
does against the fakes. Plus a cascade test proving no chunk survives a
`/forgetme` touching its range, and a test proving the lockfile rejects a second
process.

---

### WS2 — Telegram inbound: ingestion

| | |
| --- | --- |
| **Owns** | `src/adapters/inbound/telegram/poller.ts`, `src/adapters/inbound/telegram/map.ts`, `src/application/usecases/ingest-message.ts` |

Long polling with persisted `offset`. Allowlist check → unknown chat gets "not
authorised" + `leaveChat` + **stores nothing**. `Update` → `StoredMessage`
mapping at the adapter boundary (`thread_id`, `reply_to_message_id`, media →
`kind` + caption only, never the file). `edited_message` updates in place.
Upsert on `(chat_id, message_id)`. Secret redaction at ingest. Opt-out filter
stores nothing at all, not a placeholder. Startup gap detection → `gap_marker`
row. Join announcement.

**The mapping is the whole point of this workstream:** no grammY type crosses
into `application` or `domain`.

**DoD:** table-driven over recorded `Update` JSON fixtures, entirely against
fakes. Cases: forum vs non-forum, edit-in-place, replayed update is idempotent,
opted-out user leaves no trace, startup gap inserts exactly one marker.

---

### WS3 — Domain: range grammar

| | |
| --- | --- |
| **Owns** | `src/domain/range/**` |
| **Depends on** | Phase 0 types only — **pure, zero I/O** |

`parse(argString) -> {rangeSpec, question}` and
`resolve(rangeSpec, ctx) -> ResolvedRange`. Leading-token-only grammar. Bare
negative = message count; positive **requires** a unit; sign ignored when a unit
is present; bare positive → typed error carrying a help hint. PL+EN lexicons in
separate files with a registration shape making a third language additive.
`Temporal` with the chat's IANA zone, DST-correct (a `3d` range across the
October change is 73 hours). `all` keyword. **No LLM anywhere in this module.**

Time comes from the `Clock` port, passed in — never `Temporal.Now` directly.

**DoD:** the most heavily tested module in the repo. Table-driven across the
whole grammar: `-50`, `50` (error), `2h`, `-2h`, `1w`, `2026-09-15`, `wczoraj`,
`w ostatnim tygodniu`, `yesterday`, `last week`, `all 2h`, `2h co ustalili?`,
`co ustalili wczoraj?` (→ default range; "wczoraj" stays in the question),
reply-anchor + explicit range (explicit wins), DST boundaries, unknown tokens.

---

### WS4 — Anthropic adapter + prompts

| | |
| --- | --- |
| **Owns** | `src/adapters/outbound/anthropic/**`, `src/application/prompts/**`, `src/application/llm/registry.ts`, `src/application/llm/router.ts` |
| **Implements** | the `Llm` port |

`@anthropic-ai/sdk` implementation. Registry built from `Config`; keys resolved
from `apiKeyEnv`, never inline. Ordered `[{when, use}]` router, first match wins,
plus default. Token counting via `messages.count_tokens`. Structured output
schemas (`summary`, `key_points[]`, `unanswered[]`, `tone`). System prompts
carrying DESIGN §6 rules 9–13, versioned by an explicit `prompt_version`.

**Hard requirement:** instructions live **only** in the system prompt; transcript
and question go in a `user` turn inside delimited `<transcript>` / `<question>`
blocks declared as untrusted data. Never concatenate either into the system
prompt.

**DoD:** router table tests; a test asserting an unknown model in a routing rule
fails validation at load; a test asserting no user-supplied string can reach the
system prompt.

---

### WS5 — Domain: rendering + Telegram outbound

| | |
| --- | --- |
| **Owns** | `src/domain/render/**`, `src/adapters/outbound/telegram/**` |
| **Implements** | `ChatGateway` |

**Pure domain half:** HTML rendering with a strict `<b>/<i>/<code>` allowlist,
everything else escaped; `tg://` stripped; `@` mentions neutralised; slur
substitution from the configurable PL+EN wordlist; header (scope, counts, cached
marker, `⚠️` on heated tone, gap disclosure); footer; splitting on paragraph
boundaries, never inside a tag, 2–3 parts max.

**Adapter half:** grammY `ChatGateway`, placeholder + `editMessageText` throttled
to ~1/3s, link previews off, DM preference with `403` fallback, grammY throttler,
`429 retry_after` honoured exactly.

**DoD:** fuzz the escaper with hostile model output (unbalanced tags, `tg://`
links, `@everyone`, 20K characters) and assert the result is always valid
Telegram HTML under 4096 chars per part. A split must never land inside a tag.

---

### WS6 — Telegram inbound: commands + permissions

| | |
| --- | --- |
| **Owns** | `src/adapters/inbound/telegram/dispatch.ts`, `src/adapters/inbound/telegram/commands/**`, `src/domain/permissions.ts` |

Dispatcher with a **configurable command name**, `@botname` suffix stripping, and
`bot_command` entity at offset 0 as the only trigger. Three-tier `requireTier()`
in the domain (pure predicate over a `Tier`), with the `getChatMember` lookup in
the adapter. Implements `help`, `privacy`, `forgetme`, `forget`, `tz`, `model`,
`dm`, `stats`, and operator-only `config <key>` (backed by `__inspect`, §10).

**DoD:** tier matrix test — every command × every tier, allow/deny. A test
proving nothing but an explicit command triggers the bot: feed it 100 ordinary
messages including `-5 stopni jutro` and `since yesterday`, assert zero
invocations.

---

### WS7 — Config adapter (`config-layers`)

| | |
| --- | --- |
| **Owns** | `src/adapters/outbound/config/**` |
| **Implements** | the `Config` port |

`LayeredConfig.fromLayersAsync` over `defaults` → `file` → `env`. Per-chat
overrides via `__derive`, **cached per `chat_id`** and invalidated when a
settings command writes — a Proxy must not be constructed per request. Zod
validation of each layer *before* `fromLayers`, then the resolved cross-check
(every routed model exists; every `apiKeyEnv` is set; every priced model exists),
failing fast with a readable message. `__inspect` exposed through the port for
the operator `config` command.

**No config-layers type crosses the port boundary** — the port exposes a typed
config view, not a `LayeredConfig`.

**DoD:** tests for precedence across all four layers; a chat override shadowing
file and env; a routing rule naming an unknown model failing boot with a
readable error; a cache-invalidation test proving a settings write is visible on
the next read; a test proving no config key uses the reserved names
`__inspect` / `__derive` / `get` / `getAll`.

---

### WS8 — Observability adapter (GlitchTip)

| | |
| --- | --- |
| **Owns** | `src/adapters/outbound/glitchtip/**`, `src/adapters/outbound/noop-reporter.ts` |
| **Implements** | `ErrorReporter` |

`@sentry/node` pointed at `GLITCHTIP_DSN`. **No-op adapter when the DSN is
unset**, so contributors without one still get a working bot and tests never
emit. Release (git SHA), `environment` and `prompt_version` tags on every event.
The report/don't-report split from DESIGN §11.

**The scrubber is the deliverable, not a detail.** `sendDefaultPii: false`; a
`beforeSend` that drops `event.extra` and `event.contexts` wholesale and permits
only an explicit **tag allowlist**; console and HTTP-body breadcrumbs disabled;
`chat_id` / `user_id` sent as HMAC'd short tags; errors whose own message may
carry user content wrapped into a redacted type + local correlation id.

**DoD:** a test that constructs events from every error path in the codebase,
runs them through `beforeSend`, and **asserts no message text, question text,
display name or raw id survives**. Allowlist, not blocklist — include a test
adding an unexpected field and proving it is dropped.

---

### WS9 — Ops & packaging

| | |
| --- | --- |
| **Owns** | `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `README.md`, `.github/workflows/**`, `scripts/**` |

Node 26 image. Compose with the SQLite file on a **host bind mount**, explicit
`user:`, pre-created directory. Documented no-Docker path. README covering:
BotFather setup (**privacy mode off, then re-add the bot to the group** — the
step everyone misses, and without it there is no corpus), the single-instance
constraint and why (Telegram `409`), the bind-mount uid/gid trap, never-NFS, the
env var list including `GLITCHTIP_DSN`, and the known scaling path. CI:
typecheck, lint (**including the import-boundary rules**), test.

**DoD:** `docker compose up` on a clean checkout reaches a running process that
fails with a *readable* config error rather than a stack trace.

---

## Wave 2 — Parallel (starts when Wave 1 merges)

---

### WS10 — Use case: corpus + single-shot

| | |
| --- | --- |
| **Owns** | `src/domain/corpus/**`, `src/application/usecases/summarize-range.ts`, `src/application/usecases/answer-question.ts` |
| **Depends on** | WS1, WS3, WS4 |

Corpus assembly from a `ResolvedRange` (pure domain): thread scoping, bot's own
messages excluded, opt-outs filtered, gap markers surfaced as explicit
disclosure, formatting as `[HH:MM] Name: text`. Anchor older than the horizon →
clamp and say so. `count_tokens` check against `MAX_INPUT_TOKENS` **before** the
call. Under threshold → single call; over → hand off to WS11 after warning.

**DoD:** a corpus containing an opted-out user, a gap marker, a media
placeholder and a cross-topic anchor renders correctly and deterministically.

---

### WS11 — Map-reduce & chunk cache

| | |
| --- | --- |
| **Owns** | `src/domain/buckets.ts`, `src/application/compaction/**` |
| **Depends on** | WS1, WS4, WS10 |

**Bucketing is pure domain:** 6h time buckets in the chat's zone,
deterministically subdivided by count over the token threshold. **One threshold
applied recursively** — concatenate, if over `COMPACT_THRESHOLD` split and
summarize each part, repeat. Not two thresholds. Map phase on the cheap model,
reduce on the strong one. Chunk cache keyed including `model` and
`prompt_version`. Progress through the WS5 placeholder at ~1 edit / 3s.

**DoD:** **determinism test** — the same range computed twice, with a new message
arriving in between, yields identical boundaries for all completed buckets. A
recursion test reaching depth 3 on a synthetic 2M-token corpus via the fake
`Llm`. A cache test proving a `prompt_version` bump misses.

---

### WS12 — Guards & usage

| | |
| --- | --- |
| **Owns** | `src/domain/dedupe.ts`, `src/domain/cost.ts`, `src/application/guards/**`, `src/application/usage/**` |
| **Depends on** | WS1 |

Dedupe key and cost arithmetic are **pure domain**. Per-user cooldown, per-chat
concurrency of 1, dedupe (normalize → NFC → collapse → `toLocaleLowerCase('pl')`
→ strip trailing punctuation → sha256 over
`chat ‖ thread ‖ raw range token ‖ question ‖ model ‖ prompt_version`, 5-minute
TTL, result labelled as cached), per-chat daily call cap, **global USD budget as
a hard stop**. `usage_events` writer storing `unit_prices_json` per row and the
question **hash** only. Aggregate rollup job. `stats` rendering.

**DoD:** dedupe normalization tests including decomposed-vs-composed Polish
diacritics. A budget test proving the hard stop actually refuses. A test proving
the dedupe key uses the **raw** range token, not the resolved window.

---

### WS13 — Eval harness & fixtures

| | |
| --- | --- |
| **Owns** | `eval/**` |
| **Depends on** | WS4 |

Fixture loader, runner, and output diff against the previous `prompt_version`.
Hand-written **synthetic adversarial fixtures** — these need no real chat data:
sarcasm (`"if I have to do this again I'm quitting lol"` must not become "X is
quitting"), a prompt-injection attempt, a retracted message (`"sorry, wrong
chat"`), a window containing a gap marker, and a thread where nothing was
decided (must say so rather than invent one). Real-window fixtures come later,
once the ingester has a corpus; leave a documented slot.

**DoD:** `npm run eval` produces a readable per-fixture diff. Each adversarial
fixture carries a written expectation of what a correct answer must and must not
contain.

---

## Wave 3 — Integration (serial, one agent)

| | |
| --- | --- |
| **Owns** | `src/bootstrap/**` |

The composition root — the only module permitted to import from every layer.
Instantiates each adapter, injects it into the use cases, starts the poller.
Installs the `ErrorReporter` first, so a failure during the rest of boot is
itself reported. Graceful shutdown: finish the in-flight poll, flush the
reporter, release the lock.

It contains **wiring only**. Any logic that appears here belongs in a use case
or the domain — a fat composition root is the standard way a hexagonal codebase
quietly stops being one.

**DoD:** end-to-end test against the fake Telegram API and fake provider —
`/tldr -50 co ustalili?` in a forum topic produces a correctly scoped, correctly
rendered, correctly billed answer.

---

## Milestone gates

| Gate | Contains | Ship? |
| --- | --- | --- |
| **M1 — ingester live** | Phase 0 + WS1 + WS2 + WS6(`privacy`/`forgetme`/`forget`) + WS7 + WS8 + WS9 | **Deploy immediately.** No LLM dependency, no cost, and it starts accumulating the corpus everything else needs — including the real eval fixtures. It is also the only component whose bugs are *unrecoverable*: an unlogged message is gone forever. Let it bake. |
| **M2 — `/tldr` works** | + WS3 + WS4 + WS5 + WS10 + Wave 3 | Internal |
| **M3 — v1** | + WS11 + WS12 + WS13 | Ship |

While M1 is live and the rest is being built, `/tldr` replies
*"jeszcze się uczę — mam 340 wiadomości od 17.09"* rather than staying silent, so
the group knows the bot is alive and exactly what it has.

---

## Dependency graph

```
Phase 0 ─┬─> WS1 sqlite ───────┬─> WS10 corpus+single-shot ─┬─> Wave 3 bootstrap
         ├─> WS2 ingest ───────┤                            │
         ├─> WS3 range (pure) ─┤   WS11 map-reduce ──────────┤
         ├─> WS4 anthropic ────┴─> WS12 guards+usage ────────┤
         ├─> WS5 render+send        WS13 eval ───────────────┘
         ├─> WS6 commands
         ├─> WS7 config-layers
         ├─> WS8 glitchtip
         └─> WS9 ops
```

Nine agents in Wave 1, four in Wave 2. The only serial points are Phase 0 and
Wave 3 — and Phase 0 is short, because it contains no logic. Hexagonal is what
makes this parallelism real rather than nominal: a workstream owns one adapter
or one pure domain module, and the port it implements was frozen in Phase 0.

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
> Respect the layer boundaries. `domain` imports only `domain`; `application`
> imports `domain`; `adapters` import both; only `bootstrap` imports everything.
> No grammY, Anthropic SDK, better-sqlite3, Sentry or config-layers type may
> appear in `domain` or `application`. CI enforces this — if you find yourself
> wanting to relax the eslint rule, you are solving the wrong problem.
>
> Where `DESIGN.md` states a rule as "never", it is a hard constraint, not a
> default — in particular: never cross `chat_id`; never let user-supplied text
> reach a system prompt; never use an LLM to parse a range; never let a cached
> chunk outlive the messages it covers; never silently truncate a corpus; and
> never let anything the TTL or `/forgetme` would delete reach the error sink.
