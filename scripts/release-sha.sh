#!/usr/bin/env bash
# Prints the value to tag as RELEASE on every reported error event
# (DESIGN §11): the short git SHA of the current checkout, or "unknown" when
# there is no git metadata to read (a source tarball, a shallow export).
#
# Used by:
#   RELEASE=$(scripts/release-sha.sh) docker compose build
# and by .github/workflows/ci.yml for the same build-arg.
set -euo pipefail

if git rev-parse --git-dir >/dev/null 2>&1; then
  sha="$(git rev-parse --short=12 HEAD 2>/dev/null || true)"
  if [ -n "${sha}" ]; then
    if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
      sha="${sha}-dirty"
    fi
    echo "${sha}"
    exit 0
  fi
fi

echo "unknown"
