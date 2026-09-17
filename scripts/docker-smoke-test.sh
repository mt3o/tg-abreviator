#!/usr/bin/env bash
# Smoke-tests the Docker packaging on a clean checkout (PLAN WS9 DoD):
# `docker compose up` must reach a running process that fails with a
# *readable config error*, not a raw stack trace, when required secrets are
# absent.
#
# Three things are checked, in order, each one a prerequisite for the next:
#   1. `docker compose config` — the compose file parses and interpolates.
#   2. `docker build .`        — the image builds from a clean checkout.
#   3. running the image with no config/secrets present produces output that
#      looks like a deliberate, readable error (and exits non-zero) rather
#      than a Node stack trace.
#
# Step 3 needs `src/bootstrap/main.ts` (PLAN Wave 3), which is not part of
# this workstream and may not exist yet in the checkout this script is run
# against. When the built image has no dist/bootstrap/main.js, step 3 is
# skipped with a clear message instead of failing — nothing this workstream
# owns can supply that file. Once bootstrap lands, this script starts
# actually exercising the DoD without needing to change.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

image_tag="tg-abreviator:smoke-test"

echo "== 1/3: docker compose config =="
docker compose config >/dev/null
echo "ok"

echo "== 2/3: docker build =="
release="$(scripts/release-sha.sh)"
docker build --build-arg "RELEASE=${release}" -t "${image_tag}" .
echo "ok (RELEASE=${release})"

echo "== 3/3: cold start with no config/secrets =="
if ! docker run --rm "${image_tag}" test -f dist/bootstrap/main.js; then
  cat <<'EOF'
skipped: dist/bootstrap/main.js is not present in this image yet.
That file is the composition root (PLAN Wave 3, src/bootstrap/**), owned by
a different, later workstream — this script cannot build or fake it. The
image itself, however, built successfully (step 2), which is everything
this workstream (ops & packaging) controls.
EOF
  exit 0
fi

set +e
output="$(docker run --rm "${image_tag}" 2>&1)"
status=$?
set -e

echo "--- container output ---"
echo "${output}"
echo "-------------------------"

if [ "${status}" -eq 0 ]; then
  echo "FAIL: container exited 0 with no BOT_TOKEN/config.yaml — it should have refused to start." >&2
  exit 1
fi

# A raw, unhandled Node stack trace looks like "at Object.<anonymous> (...)"
# or starts with "Error:"/"TypeError:" followed by "    at " frames with no
# surrounding explanation. A deliberate, readable error does not need to
# avoid the word "Error" — it needs to avoid dumping a bare stack.
if echo "${output}" | grep -Eq '^\s+at [A-Za-z]'; then
  echo "FAIL: output looks like a raw stack trace, not a readable config error." >&2
  exit 1
fi

echo "ok: exited ${status} with a readable message, no stack trace."
