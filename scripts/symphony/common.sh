#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
vendor_root="$repo_root/.vendor/symphony"
symphony_elixir_dir="$vendor_root/elixir"
local_env_file="$repo_root/.env.symphony.local"

keychain_service_api_key="octop.symphony.linear_api_key"

load_local_env() {
  if [[ -f "$local_env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$local_env_file"
    set +a
  fi
}

require_command() {
  local cmd="$1"
  local hint="${2:-}"

  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing command: $cmd" >&2
    if [[ -n "$hint" ]]; then
      echo "$hint" >&2
    fi
    return 1
  fi
}

ensure_brew_formula() {
  local formula="$1"

  if brew list --versions "$formula" >/dev/null 2>&1; then
    return 0
  fi

  HOMEBREW_NO_AUTO_UPDATE=1 brew install "$formula"
}

ensure_vendor_clone() {
  mkdir -p "$repo_root/.vendor"

  if [[ ! -d "$vendor_root/.git" ]]; then
    git clone --depth 1 https://github.com/openai/symphony "$vendor_root"
    return 0
  fi

  git -C "$vendor_root" fetch --depth 1 origin main
  git -C "$vendor_root" reset --hard origin/main
}

read_keychain_secret() {
  local service="$1"

  security find-generic-password -a "$USER" -s "$service" -w 2>/dev/null || true
}

load_runtime_env() {
  load_local_env

  export SOURCE_REPO_URL="${SOURCE_REPO_URL:-$repo_root}"
  export SYMPHONY_WORKSPACE_ROOT="${SYMPHONY_WORKSPACE_ROOT:-$HOME/code/symphony-workspaces/octop}"
  export CODEX_BIN="${CODEX_BIN:-$(command -v codex || true)}"

  if [[ -z "${LINEAR_API_KEY:-}" ]]; then
    LINEAR_API_KEY="$(read_keychain_secret "$keychain_service_api_key")"
    export LINEAR_API_KEY
  fi
}

check_required_runtime_env() {
  local missing=0

  if [[ -z "${LINEAR_API_KEY:-}" ]]; then
    echo "missing LINEAR_API_KEY: run scripts/symphony/setup-secrets.sh first" >&2
    missing=1
  fi

  if [[ -z "${LINEAR_PROJECT_SLUG:-}" ]]; then
    echo "missing LINEAR_PROJECT_SLUG: set it in .env.symphony.local" >&2
    missing=1
  fi

  if [[ -z "${CODEX_BIN:-}" ]]; then
    echo "missing codex binary in PATH" >&2
    missing=1
  fi

  return "$missing"
}
