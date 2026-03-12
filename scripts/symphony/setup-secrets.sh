#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/common.sh"

umask 077

read -r -p "Linear project slug: " linear_project_slug
read -r -p "Workspace root [$HOME/code/symphony-workspaces/octop]: " workspace_root
workspace_root="${workspace_root:-$HOME/code/symphony-workspaces/octop}"
read -r -p "Source repo URL [$repo_root]: " source_repo_url
source_repo_url="${source_repo_url:-$repo_root}"

printf "Linear API key (input hidden): "
stty -echo
read -r linear_api_key
stty echo
printf "\n"

if [[ -z "$linear_api_key" ]]; then
  echo "Linear API key is required." >&2
  exit 1
fi

if [[ -z "$linear_project_slug" ]]; then
  echo "Linear project slug is required." >&2
  exit 1
fi

security add-generic-password \
  -a "$USER" \
  -s "$keychain_service_api_key" \
  -w "$linear_api_key" \
  -U >/dev/null

{
  printf 'LINEAR_PROJECT_SLUG=%q\n' "$linear_project_slug"
  printf 'SYMPHONY_WORKSPACE_ROOT=%q\n' "$workspace_root"
  printf 'SOURCE_REPO_URL=%q\n' "$source_repo_url"
} >"$local_env_file"

echo "saved LINEAR_API_KEY to macOS Keychain service: $keychain_service_api_key"
echo "saved non-secret runtime config to $local_env_file"
