#!/usr/bin/env bash
# Image hygiene for a built Cartoona image (V0.1.56). Read-only.
#
#   scripts/ci/check-image.sh <image-ref>
#
# Fails when the image:
#   * runs as root (Config.User empty, root or 0),
#   * contains an environment file, a private key or a certificate bundle we
#     did not expect (anything named .env / .env.* / *.pem / *.key outside the
#     base image's own system directories),
#   * carries a known runtime-secret variable name in its configured
#     environment or in its build history (build args are visible there).
set -euo pipefail
img="${1:?usage: check-image.sh <image-ref>}"
failed=0
bad() { echo "::error::$img: $*"; failed=1; }

user="$(docker image inspect --format '{{.Config.User}}' "$img")"
case "$user" in ""|root|0|0:0) bad "runs as root (Config.User='$user')" ;; esac

# Search the application tree and every writable location, not the distro's
# own /usr and /etc (CA bundles there are expected and public).
found="$(docker run --rm --network none --entrypoint /bin/sh "$img" -c \
  'find / -xdev \( -path /proc -o -path /sys -o -path /usr -o -path /etc \) -prune -o \( -name ".env" -o -name ".env.*" -o -name "*.pem" -o -name "*.key" -o -name "id_rsa" -o -name "id_ed25519" \) -print 2>/dev/null' || true)"
if [ -n "$found" ]; then
  while IFS= read -r f; do bad "unexpected secret-like file in image: $f"; done <<< "$found"
fi

SECRET_NAMES='SUPABASE_SECRET_KEY|POSTGRES_PASSWORD|CARTOONA_APP_DB_PASSWORD|CARTOONA_INTERNAL_AUTH_SECRET|RATE_LIMIT_HASH_SECRET|DATABASE_URL|BACKEND_DATABASE_URL|DEV_PARENT_AUTH_SECRET|GITHUB_TOKEN|GH_TOKEN'
if docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$img" | grep -qE "^($SECRET_NAMES)="; then
  bad "a runtime secret variable is baked into the image environment"
fi
if docker history --no-trunc --format '{{.CreatedBy}}' "$img" | grep -qE "($SECRET_NAMES)="; then
  bad "a runtime secret variable appears in the build history"
fi

[ "$failed" = 0 ] && echo "check-image: $img OK (user=$user)"
exit "$failed"
