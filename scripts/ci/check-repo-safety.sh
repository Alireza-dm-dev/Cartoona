#!/usr/bin/env bash
# Repository safety checks for CI (V0.1.56). Read-only; prints names, never
# file contents or matched values.
#
#   scripts/ci/check-repo-safety.sh [base-commit]
#
# 1. No real environment file, key or certificate is tracked.
# 2. No tracked file contains a private-key block.
# 3. database/migrations: NNNN_lower_snake.sql, numbered 0001..N without gaps,
#    and — relative to base-commit, when given — existing migrations were only
#    ADDED to, never modified, renamed or deleted (an applied migration is
#    immutable; migrate-local.sh refuses a changed checksum at apply time, this
#    catches it at review time).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
base="${1:-}"
failed=0
bad() { echo "::error::$*"; failed=1; }

# ── 1. tracked secret-bearing files ──────────────────────────────────────────
while IFS= read -r f; do
  case "$f" in
    .env.example|.env.local.example|.env.docker.example) ;;
    *) bad "tracked environment file: $f" ;;
  esac
done < <(git ls-files | grep -E '(^|/)\.env($|\.)' || true)

while IFS= read -r f; do bad "tracked key/certificate file: $f"; done \
  < <(git ls-files | grep -E '\.(pem|key|p12|pfx)$|(^|/)id_(rsa|ecdsa|ed25519)(\.pub)?$' || true)

# ── 2. private key material in any tracked file ─────────────────────────────
while IFS= read -r f; do bad "private key block in tracked file: $f"; done \
  < <(git grep -lIE -e '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----' -- . ':!scripts/ci/check-repo-safety.sh' || true)

# ── 3. migrations ────────────────────────────────────────────────────────────
expected=1
while IFS= read -r f; do
  name="$(basename "$f")"
  [[ "$name" =~ ^([0-9]{4})_[a-z0-9_]+\.sql$ ]] || { bad "migration name is not NNNN_lower_snake.sql: $name"; continue; }
  n=$((10#${BASH_REMATCH[1]}))
  [ "$n" -eq "$expected" ] || bad "migration numbering gap or duplicate at $name (expected $(printf '%04d' "$expected"))"
  expected=$((n + 1))
done < <(git ls-files 'database/migrations/*.sql' | LC_ALL=C sort)
echo "check-repo-safety: migration names and numbering checked"

if [ -n "$base" ] && ! [[ "$base" =~ ^0+$ ]]; then
  if git cat-file -e "$base^{commit}" 2>/dev/null; then
    while IFS=$'\t' read -r status path _; do
      [ "$status" = A ] || bad "existing migration changed ($status): $path - add a new migration instead"
    done < <(git diff --name-status --no-renames "$base" HEAD -- database/migrations)
    echo "check-repo-safety: migration immutability checked against $base"
  else
    bad "base commit $base is not available (fetch-depth too shallow?)"
  fi
else
  echo "check-repo-safety: no base commit - migration immutability not checked"
fi

[ "$failed" = 0 ] && echo "check-repo-safety: OK"
exit "$failed"
