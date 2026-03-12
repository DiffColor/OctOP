#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/common.sh"

port="${SYMPHONY_PORT:-4100}"
logs_root="${SYMPHONY_LOGS_ROOT:-$repo_root/.symphony/log}"
workflow_path="$repo_root/WORKFLOW.md"

require_command brew "Install Homebrew first: https://brew.sh"
require_command git
require_command security
require_command codex

ensure_brew_formula mise
ensure_brew_formula gh

require_command mise
require_command gh

load_runtime_env
check_required_runtime_env

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login" >&2
  exit 1
fi

ensure_vendor_clone
mkdir -p "$logs_root" "$SYMPHONY_WORKSPACE_ROOT"

cd "$symphony_elixir_dir"
mise trust
mise install
mise exec -- mix setup
mise exec -- mix build

exec mise exec -- ./bin/symphony "$workflow_path" --logs-root "$logs_root" --port "$port"
