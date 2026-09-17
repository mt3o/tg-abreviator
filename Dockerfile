# tg-abreviator — container image (DESIGN §3, PLAN WS9).
#
# Runtime shape this image assumes:
#   - long polling, not a webhook: no port is exposed, nothing listens.
#   - exactly one instance may run against a given bot token (Telegram 409);
#     the single-instance lockfile (DESIGN §3) is enforced by the process
#     itself, not by this file.
#   - SQLite lives on a host bind mount, never a named volume and never NFS
#     (DESIGN §3) — see docker-compose.yml and README.md "Running with
#     Docker" for the uid/gid trap that bind mount implies.
#
# `better-sqlite3` is a native addon. Debian's glibc image has prebuilt
# binaries for the common platforms most of the time, but the deps stage
# still carries a C++ toolchain so an `npm ci` that falls back to compiling
# from source (a platform/arch prebuild misses, an ABI bump) succeeds instead
# of failing the build.
#
# Default pulls through mirror.gcr.io (Google's public, unauthenticated
# read-through cache of Docker Hub) rather than docker.io directly, so a
# build does not depend on Docker Hub's anonymous-pull rate limit. Override
# with `--build-arg NODE_IMAGE=node:22-bookworm-slim` (or your own mirror) if
# your network reaches Docker Hub directly and you'd rather use it.
ARG NODE_IMAGE=mirror.gcr.io/library/node:22-bookworm-slim

# ---------------------------------------------------------------------------
# deps: the full (dev + prod) dependency tree, built once and reused below.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# build: compile TypeScript to dist/ (tsconfig.build.json — no test files).
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# prod-deps: production-only node_modules, same toolchain available in case
# a native module needs rebuilding for this exact base image.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# runtime: the image that actually ships. No compiler, no dev deps, no src/.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Tagged on every reported error event (DESIGN §11). Passed with
# `docker build --build-arg RELEASE=$(git rev-parse --short HEAD)`; see
# scripts/release-sha.sh. Falls back to "unknown" for a build outside git
# (e.g. `docker build` from a source tarball).
ARG RELEASE=unknown
ENV RELEASE=${RELEASE}

# Runs as a fixed, non-root uid:gid so the docker-compose.yml `user:` mapping
# and the pre-created host `./data` directory (README.md "Running with
# Docker") agree on who owns the bind-mounted SQLite file. 10001 is chosen to
# be unlikely to collide with a host system account.
RUN groupadd --gid 10001 tgabbr \
    && useradd --uid 10001 --gid tgabbr --no-create-home --shell /usr/sbin/nologin tgabbr \
    && mkdir -p /app/data \
    && chown -R tgabbr:tgabbr /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER tgabbr

# `./data` is where DATABASE_PATH / DATABASE_LOCK_PATH point by default
# (config.example.yaml) and where docker-compose.yml binds the host
# directory. Declared as a volume so `docker compose up` on a plain `docker
# run` still gets a distinct, inspectable mount point even without compose.
VOLUME ["/app/data"]

# The composition root (src/bootstrap, DESIGN §3) validates configuration
# before touching Telegram or the database and exits with a readable message
# on failure rather than a stack trace (DESIGN §10 step 5) — see README.md
# "Troubleshooting: config errors on startup".
CMD ["node", "dist/bootstrap/main.js"]
