#!/usr/bin/env bash
# Run one security-audit-skill target-execution step inside a locked-down container.
#
# Restrictions (match the skill's OS-sandbox requirements):
#   --network none            no external networking
#   --read-only               root filesystem is immutable
#   --tmpfs /work             the only writable path (scratch), size-capped
#   bind mount ro             target repo is readable, never writable
#   --memory/--cpus/...       resource limits
#   --cap-drop ALL            no capabilities; no-new-privileges set
#   --env-file                sanitized allowlisted environment only
#
# Usage: run-audit-sandbox.sh <target-repo-dir> [<command>...]
#        (default command: bash)
set -euo pipefail

TARGET="${1:?usage: run-audit-sandbox.sh <target-repo-dir> [<command>...]}"
shift || true
TARGET="$(cd "$TARGET" && pwd)"
IMAGE="${IMAGE:-security-audit-sandbox:latest}"
SCRATCH_SIZE="${SCRATCH_SIZE:-2g}"
MEM="${MEM:-4g}"
CPUS="${CPUS:-2}"

ENV_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE"' EXIT
# Sanitized allowlist: nothing else from the host environment reaches the target.
cat >"$ENV_FILE" <<'EOF'
LANG=C.UTF-8
LC_ALL=C.UTF-8
HOME=/work
EOF

mkdir -p "$HOME/.audit-scratch"

TTY_FLAGS=()
[ -t 0 ] && TTY_FLAGS+=(-t) || true
# Wall-clock limit: non-interactive commands get `timeout` (AUDIT_TIMEOUT, default 900s).
if [ "$#" -gt 0 ]; then
  exec docker run --rm ${TTY_FLAGS[@]+"${TTY_FLAGS[@]}"} \
    --network none \
    --read-only \
    --tmpfs "/work:rw,size=${SCRATCH_SIZE},uid=1000" \
    --mount "type=bind,src=${TARGET},dst=/target,readonly" \
    --env-file "$ENV_FILE" \
    --memory "$MEM" --cpus "$CPUS" --pids-limit 256 \
    --ulimit nofile=1024:2048 --ulimit fsize=1073741824 \
    --cap-drop ALL --security-opt no-new-privileges \
    --user 1000:1000 \
    "$IMAGE" timeout "${AUDIT_TIMEOUT:-900}" "$@"
fi
# ${arr[@]+...} guards empty-array expansion under set -u on bash 3.2 (macOS).
exec docker run --rm ${TTY_FLAGS[@]+"${TTY_FLAGS[@]}"} \
  --network none \
  --read-only \
  --tmpfs "/work:rw,size=${SCRATCH_SIZE},uid=1000" \
  --mount "type=bind,src=${TARGET},dst=/target,readonly" \
  --env-file "$ENV_FILE" \
  --memory "$MEM" --cpus "$CPUS" --pids-limit 256 \
  --ulimit nofile=1024:2048 --ulimit fsize=1073741824 \
  --cap-drop ALL --security-opt no-new-privileges \
  --user 1000:1000 \
  "$IMAGE" "$@"
