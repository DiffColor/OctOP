#!/usr/bin/env sh
set -eu

STATE_HOME="${OCTOP_STATE_HOME:-/var/lib/octop}"
CODEX_HOME_VALUE="${CODEX_HOME:-/var/lib/codex}"
WORKSPACE_ROOTS_VALUE="${OCTOP_WORKSPACE_ROOTS:-/workspace}"

mkdir -p "$STATE_HOME" "$CODEX_HOME_VALUE"
chmod 700 "$STATE_HOME" "$CODEX_HOME_VALUE" 2>/dev/null || true

if [ -n "${CODEX_AUTH_JSON:-}" ] && [ ! -f "$CODEX_HOME_VALUE/auth.json" ]; then
  printf '%s' "$CODEX_AUTH_JSON" > "$CODEX_HOME_VALUE/auth.json"
  chmod 600 "$CODEX_HOME_VALUE/auth.json"
fi

export OCTOP_STATE_HOME="$STATE_HOME"
export CODEX_HOME="$CODEX_HOME_VALUE"
export OCTOP_WORKSPACE_ROOTS="$WORKSPACE_ROOTS_VALUE"
export OCTOP_BRIDGE_HOST="${OCTOP_BRIDGE_HOST:-0.0.0.0}"
export OCTOP_BRIDGE_PORT="${OCTOP_BRIDGE_PORT:-4100}"
export OCTOP_APP_SERVER_WS_URL="${OCTOP_APP_SERVER_WS_URL:-ws://127.0.0.1:4600}"
export OCTOP_APP_SERVER_COMMAND="${OCTOP_APP_SERVER_COMMAND:-codex app-server --listen ${OCTOP_APP_SERVER_WS_URL}}"

cd /opt/octop
exec node ./scripts/run-bridge.mjs "$@"
