# Handoff — what's left to do

Everything in [`docs/PLAN.md`](PLAN.md) is built and merged. Nothing in the
codebase is waiting on more code.

What remains is **operational**, and it splits into things you do once to get
the bot live, and one thing you can only do after it has been running.

Setup detail lives in the [README](../README.md); this is the list of things
that are easy to forget, plus the steps that happen outside this repository.

---

## Before the first run

### Outside the repo

- [ ] **BotFather: turn Group Privacy OFF.** `/mybots` → bot → *Bot Settings* →
      *Group Privacy* → *Turn off*.
- [ ] **Re-add the bot to any group it is already in.** Privacy mode is read
      once, when the bot joins. Flipping the setting does nothing to an
      existing membership — the bot keeps seeing only `/commands` until it is
      kicked and re-invited. *This is the single most likely reason a fresh
      deployment sits there with an empty corpus and no error.*
- [ ] **Create the GlitchTip project(s)** — `tg-abreviator-prod` (and `-dev` if
      you want one), platform `node`, matching the existing `punktomat-*` /
      `ytshield-*` convention. Copy the DSN.
- [ ] **Set GlitchTip's per-project event retention to no longer than the
      message TTL.** This is a dashboard setting, not code, and
      [DESIGN §11](DESIGN.md#11-observability--glitchtip) depends on it: error
      events carry a pseudonymous label, `/forgetme` cannot reach GlitchTip's
      copy, and bounded retention is what makes that acceptable.
- [ ] **Update `/privacy` wording** if you want it to name the diagnostics
      retention window explicitly (DESIGN §11 says it should).

### In the repo

- [ ] `cp config.example.yaml config.yaml` and fill it in. Every knob is
      documented inline.
- [ ] **Add each group's `chat_id` to `telegram.allowlist` BEFORE inviting the
      bot.** Anywhere not allowlisted, it replies "not authorised", leaves, and
      stores nothing — deliberate, per DESIGN §5.
- [ ] `cp .env.example .env` and set `BOT_TOKEN`, `ANTHROPIC_API_KEY`,
      `GLITCHTIP_DSN`, `ENVIRONMENT=prod`, and `OPERATOR_USER_IDS` (your own
      Telegram user id — tier `operator`, allowed anywhere).
- [ ] Decide `TTL_HARD_CAP_DAYS`. Nothing in `config.yaml` can exceed it, so
      no per-chat setting can quietly become "forever".
- [ ] Confirm `data/` is a **host bind mount**, owned by the container's `user:`.
      Never NFS — WAL over NFS corrupts the database.

Config is validated at boot and fails fast with a readable message, so a
missing key gives you a sentence, not a stack trace. If it starts, the config
is sound.

---

## Then: let it log

Deploy the ingester and leave it alone for a while. It costs nothing (no LLM
calls happen until someone invokes the command) and it is accumulating the
corpus that everything else needs.

While it is running, `/tldr` answers honestly that it is still learning and how
much it has, rather than staying silent.

---

## After a couple of weeks — the one thing only you can do

- [ ] **Fill `eval/fixtures/real-window.ts`.** It is an empty array behind a
      comment explaining the shape. Pick 3–5 real windows from your own groups,
      and **hand-write what a correct answer must and must not say, before
      reading what the bot produced.**

This matters more than it sounds. Every test that passes today ran against a
**fake LLM**. Nothing has yet checked whether the summaries are any *good* —
only that the plumbing is correct. A summarizer fails invisibly: it invents a
decision nobody made, reads a joke as a plan, or misses the one message that
mattered, and it does all of that in fluent Polish with a confident tone.

Redact anything in those fixtures that would not itself survive the TTL or
`/forgetme` — DESIGN §5 and §11 apply to fixture data too, even though it never
reaches the database.

Then `npm run eval` gives you a per-fixture diff on every prompt change.

---

## Deferred on purpose — don't re-litigate these

| Item | Why |
| --- | --- |
| Prompt caching | The transcript is ~95% of the tokens and changes every call, so naive caching buys nothing. Revisit only when the usage stats show the bill justifies it (DESIGN §7). |
| LLM-as-judge scoring | With a handful of fixtures you read them yourself in three minutes and learn more than a number would tell you. |
| Backfill / MTProto | The Bot API cannot read history, and a user-account login's blast radius is not worth retroactive summaries (DESIGN §13). |
| Horizontal scaling | Telegram permits exactly one poller per token. The scaling path, if ever needed, is 1 ingester + N workers + Postgres — not N identical containers. |

---

## Notes for the next agent run

- **The branch `claude/brave-mayer-psecmb` has merged PRs against it.** Restart
  it from `main` before new work rather than stacking on merged history.
- **Contracts-first parallelism catches shape drift, not behavioural
  hand-offs.** In the run that built this, two workstreams had correct types on
  both sides of a call that neither of them made — compaction was fully built,
  fully tested, and never invoked. Everything compiled and every test passed
  with a v1 feature silently absent. If you fan out again, add a wave-boundary
  check that every new module has a caller, not just that it typechecks.
- **Don't let an agent run a container with the repo bind-mounted.** One did,
  `npm ci --omit=dev` crashed mid-prune, and it half-deleted `node_modules` on
  the host for every other agent running at the time.
