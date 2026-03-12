#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/common.sh"

load_runtime_env

status=0

check_cmd() {
  local cmd="$1"
  if command -v "$cmd" >/dev/null 2>&1; then
    printf "[ok] %s -> %s\n" "$cmd" "$(command -v "$cmd")"
  else
    printf "[missing] %s\n" "$cmd"
    status=1
  fi
}

check_cmd codex
check_cmd brew
check_cmd git
check_cmd security
check_cmd mise
check_cmd gh

if [[ -n "${LINEAR_API_KEY:-}" ]]; then
  echo "[ok] LINEAR_API_KEY -> loaded from Keychain or environment"
else
  echo "[missing] LINEAR_API_KEY -> run scripts/symphony/setup-secrets.sh"
  status=1
fi

if [[ -n "${LINEAR_PROJECT_SLUG:-}" ]]; then
  echo "[ok] LINEAR_PROJECT_SLUG -> $LINEAR_PROJECT_SLUG"
else
  echo "[missing] LINEAR_PROJECT_SLUG -> set it in .env.symphony.local"
  status=1
fi

echo "[info] SOURCE_REPO_URL -> ${SOURCE_REPO_URL:-unset}"
echo "[info] SYMPHONY_WORKSPACE_ROOT -> ${SYMPHONY_WORKSPACE_ROOT:-unset}"

if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    echo "[ok] gh auth"
  else
    echo "[missing] gh auth -> run gh auth login"
    status=1
  fi
fi

exit "$status"
