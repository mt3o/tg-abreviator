# tg-abreviator

Telegram bot for making a summary when people talk a lot but you don't have time
to read all of this.

Reply to a message and call the bot to get a summary from that point on. Ask a
question instead and it answers from the chat history. Give it a timeframe
(`2h`, `wczoraj`, `last week`) or a message count (`-50`) and it uses that range.

## Status

Implementation in progress, built as parallel workstreams against frozen
Phase 0 contracts. See [`docs/PLAN.md`](docs/PLAN.md) for what is done and
what is still in flight.

Hexagonal (ports and adapters): a pure domain, use cases behind ports, and one
adapter per external system — Telegram, Anthropic, SQLite,
[`config-layers`](https://github.com/mt3o/config-layers) for configuration, and
GlitchTip for error reporting.

- [`docs/DESIGN.md`](docs/DESIGN.md) — what is being built and why, including the
  Telegram API constraints that shape the whole thing, the privacy/retention
  model, and the safety rules.
- [`docs/PLAN.md`](docs/PLAN.md) — how it gets built: ports and adapters, with
  contracts frozen first, then workstreams with disjoint file ownership
  designed to be implemented in parallel.

## The one thing to know before running this

The Telegram Bot API **cannot read chat history**. The bot can only summarize
messages it witnessed and stored itself, which means:

- privacy mode must be **off** in BotFather **and the bot re-added to the
  group**, otherwise it receives nothing and there is no corpus (see below —
  this is the step almost everyone misses);
- nothing before installation can ever be summarized;
- messages are kept for a configurable TTL and then deleted.

See [`docs/DESIGN.md`](docs/DESIGN.md) §1 and §5.

---

## BotFather setup

1. Talk to [@BotFather](https://t.me/BotFather), `/newbot`, save the token —
   that is `BOT_TOKEN`.
2. **Turn privacy mode off**: `/mybots` → your bot → *Bot Settings* → *Group
   Privacy* → *Turn off*.
3. **If the bot is already in any group, remove it and re-add it.** Privacy
   mode is read once, when the bot joins a chat. Flipping the BotFather
   setting does nothing to a membership that already exists — the bot keeps
   receiving only `/commands` and replies to itself until it is kicked and
   invited again. This is the single most common reason a fresh deployment
   sits there with an empty corpus.
4. Add every group (or supergroup) the bot should operate in to
   `telegram.allowlist` in `config.yaml` (see below) **before** inviting it,
   or it replies "not authorised" and immediately leaves
   ([`docs/DESIGN.md`](docs/DESIGN.md) §5 — this is deliberate, not a bug).
5. Alternatively, make the bot a **group admin**: admins receive every
   message regardless of privacy mode. Still respect the allowlist.

## Configuration

Four layers, lowest priority first — see [`docs/DESIGN.md`](docs/DESIGN.md)
§10 for the full model:

| Layer | Where | Holds | Changed by |
| --- | --- | --- | --- |
| `defaults` | built into the release | sane values for everything | a release |
| `file` | `config.yaml` | model registry, routing, prices, thresholds, caps, command name, allowlist, slur wordlist, per-chat TTL | edit + restart |
| `env` | environment variables | secrets, paths, hard caps | redeploy |
| `chat` | SQLite, per chat | tz / model override | bot commands, live |

Start from the template — every knob is documented inline there:

```sh
cp config.example.yaml config.yaml
```

At minimum, set `bot.operatorContact` and `telegram.allowlist` before the
first run. There is **no hot reload**: editing `config.yaml` requires a
restart. Chat-level overrides are live precisely because they come from the
database instead.

### Environment variables

Secrets and machine-specific values only — everything else belongs in
`config.yaml`. Putting a secret in `config.yaml` fails validation rather than
silently working, because that file is meant to be kept in version control.

| Variable | Required | Meaning |
| --- | --- | --- |
| `BOT_TOKEN` | yes | From BotFather. |
| `ANTHROPIC_API_KEY` | yes, if referenced | Read by name via `apiKeyEnv` in `config.yaml`'s model registry — never hardcoded, this repo is public. |
| `DATABASE_PATH` | no | Overrides `database.path`. In Docker, always under the bind-mounted `./data`. |
| `DATABASE_LOCK_PATH` | no | Overrides `database.lockPath`. Same mount. |
| `OPERATOR_USER_IDS` | no | Comma-separated Telegram user ids. Tier `operator`: allowed anywhere, including outside the allowlist, for administration. |
| `TTL_HARD_CAP_DAYS` | no | Ceiling nothing in `config.yaml` can exceed. Nothing can set "forever" without a redeploy. |
| `GLITCHTIP_DSN` | no | Unset selects the no-op error reporter — the bot runs fine without one, and tests never emit regardless. |
| `ENVIRONMENT` | no | `dev` \| `preprod` \| `prod` \| `test`. Tagged on every reported event. |
| `RELEASE` | no | Git SHA, tagged on every reported event. The Docker image sets this at build time (see below); `scripts/release-sha.sh` computes it the same way locally and in CI. |
| `LOG_LEVEL` | no | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal`. |
| `CONFIG_PATH` | no | Where to read `config.yaml` from. Defaults to `config.yaml` in the working directory, which is what both the image (`/app/config.yaml`) and the no-Docker path below already give you. |

`cp .env.example .env` and fill it in for either the Docker or the no-Docker
path below. `.env` is git-ignored.

---

## Running with Docker

```sh
mkdir -p data
chown 10001:10001 data     # see "the bind-mount uid/gid trap" below
cp config.example.yaml config.yaml   # then edit it
cp .env.example .env                 # then fill in BOT_TOKEN, ANTHROPIC_API_KEY
docker compose up -d
docker compose logs -f
```

### The bind-mount uid/gid trap

`database.path` points at `./data` on a **host bind mount**, deliberately —
never a named volume (see "Never NFS" below). The container runs as a fixed
non-root user, uid:gid `10001:10001` (baked into the image as `tgabbr`), and
that user has to be able to create and write `tg-abreviator.db`,
`-wal`, `-shm` and the lockfile on the host directory it sees mounted at
`/app/data`.

If the host directory is missing, or owned by someone else, the container
starts, SQLite fails to open the file, and it looks like a database bug when
it is really a permissions mismatch. Pre-create the directory and `chown` it
to `10001:10001` (or override both `APP_UID`/`APP_GID` in `.env` *and* chown
to match) before the first `docker compose up`. This is by far the most
common first-run failure of a bind-mounted SQLite container.

### Never NFS

The database directory must be a real local filesystem. `PRAGMA
journal_mode=WAL` — required for a single-writer, low-latency workload like
this — **corrupts silently over NFS** because NFS does not implement the file
locking WAL relies on. A network-backed "local" mount (some managed-disk
setups, some CI runners) can be NFS underneath without saying so; if in
doubt, write a file, `fuser`/`flock` it, and confirm the lock actually holds
another process out.

### Single instance, enforced

Telegram allows **exactly one** long-poller per bot token — a second process
polling the same token gets an immediate `409 Conflict`
([`docs/DESIGN.md`](docs/DESIGN.md) §1, §3). The process holds a lockfile at
`database.lockPath` (via `flock`) and refuses to start, loudly, if another
instance already holds it. Do not scale the `app` service in
`docker-compose.yml` past one replica — see "Scaling" below for the actual
path when one process is not enough.

### Build-time release tag

```sh
RELEASE=$(scripts/release-sha.sh) docker compose build
```

`docker compose up` picks this up automatically (`docker-compose.yml` passes
`RELEASE` through as a build arg with `unknown` as the fallback) if you
export it first, or from a `RELEASE=...` line in `.env`. This is what tags
every reported error with the exact revision that produced it
([`docs/DESIGN.md`](docs/DESIGN.md) §11).

### Troubleshooting: config errors on startup

The process validates the full resolved configuration — every layer,
cross-checked (every routed model exists, every `apiKeyEnv` is actually set,
every priced model exists, the allowlist isn't empty, and so on;
[`docs/DESIGN.md`](docs/DESIGN.md) §10) — **before** it touches Telegram or
the database, and exits with every problem it found printed as a short list,
not a stack trace:

```
configuration failed validation:
  - telegram.allowlist: the allowlist is empty: the bot would refuse and leave every chat
  - models.registry.sonnet.apiKeyEnv: environment variable ANTHROPIC_API_KEY is not set
```

`docker compose logs` on a container that exited immediately after starting
almost always means exactly this: fix the listed paths in `config.yaml` /
`.env` and `docker compose up` again.

---

## Running without Docker

Docker is the documented path, not the only one:

```sh
npm ci
npm run build
cp config.example.yaml config.yaml   # then edit it
cp .env.example .env                 # then fill in secrets
export $(grep -v '^#' .env | xargs)  # or use a process manager's env support
node dist/bootstrap/main.js
```

Requirements: Node 22.12+ (the engine floor in `package.json`; native
`Temporal` lands unflagged in a later Node release, and until then the code
runs against `temporal-polyfill` through a single swap point, so both work
identically). Everything else — the SQLite path being a real local
filesystem and never NFS, the single-instance lockfile — applies exactly as
in the Docker case above.

---

## Scaling

There is one poller, ever, because Telegram permits exactly one per token.
The known scaling path when a single process stops being enough is **1
ingester + N workers + Postgres + a queue** — the ingester stays the sole
long-poller and hands work off; it is **not** more containers of this image
([`docs/DESIGN.md`](docs/DESIGN.md) §3). Nothing in this repository builds
that yet.

---

## Privacy

`/privacy` in the bot states what is stored, the TTL, and how to reach the
operator. See [`docs/DESIGN.md`](docs/DESIGN.md) §5 for the full retention
and erasure model — it is the actual product, not an appendix.

---

## Development

```sh
npm ci
npm run typecheck
npm run lint                    # includes the import-boundary rules, CI-enforced
npm run lint:boundaries-fixture # proves the boundary rules actually fire
npm test
npm run build
npm run eval                    # the prompt-quality eval harness
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint (including the
boundary rules), the test suite, and a Docker build smoke test on every push
and pull request.

### Workstream rules

If you are an agent or contributor picking up one of the parallel
workstreams in [`docs/PLAN.md`](docs/PLAN.md): read it and
[`docs/DESIGN.md`](docs/DESIGN.md) first. Contracts under `src/domain/` and
`src/application/ports/` are frozen after Phase 0; each workstream owns a
disjoint set of files, listed in its card.
