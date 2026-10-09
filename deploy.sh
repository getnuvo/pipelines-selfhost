#!/usr/bin/env bash
# Ingestro Pipelines — Azure private network deployment (provider azure-docker).
#
#   ./deploy.sh                          interactive
#   ./deploy.sh --answers acme-dev.answers.yaml    batch (see deploy.answers.example.yaml)
#   ./deploy.sh --help
#
# Checks the tools, installs the npm dependencies, then starts the wizard (wizard/index.ts).
# Safe to re-run: nothing is reinstalled, and the wizard resumes from the stack config.
set -euo pipefail
# Run from the repo, also when started through a symlink (e.g. one on the PATH).
script="$0"
while [ -L "$script" ]; do
  dir="$(cd -P "$(dirname "$script")" && pwd)"
  script="$(readlink "$script")"
  case "$script" in /*) ;; *) script="$dir/$script" ;; esac
done
cd -P "$(dirname "$script")"

BATCH=0
HELP=0
for arg in "$@"; do
  case "$arg" in
    --answers | --answers=*) BATCH=1 ;;
    -h | --help) HELP=1 ;;
  esac
done

# Usage needs nothing installed: show the full help once the dependencies are there.
if [ "$HELP" = 1 ] && [ ! -x node_modules/.bin/tsx ]; then
  printf '%s\n' \
    'Usage: ./deploy.sh [destroy] [options]' \
    '' \
    'Deploys Ingestro Pipelines on Azure (private network). The first run checks Node.js 20+,' \
    'Pulumi and the Azure CLI and installs the npm dependencies; ./deploy.sh --help then lists' \
    'every option. Guide: docs/azure-docker/guide.md'
  exit 0
fi

say() { printf '%s\n' "$*"; }
die() {
  if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
    printf '\033[31m✗\033[0m %s\n' "$*" >&2
  else
    printf '✗ %s\n' "$*" >&2
  fi
  exit 1
}

# Offer to run an install command, unless in batch mode (then just fail with it).
offer() {
  local tool="$1" command="$2"
  if [ "$BATCH" = 1 ] || [ ! -t 0 ]; then
    die "$tool is missing. Install it with: $command"
  fi
  printf '%s is missing. Install it now with:\n  %s\n[y/N] ' "$tool" "$command"
  read -r reply
  case "$reply" in
    y | Y) eval "$command" ;;
    *) die "Install $tool, then run ./deploy.sh again." ;;
  esac
}

# Node.js 20+ (the wizard and the Pulumi program run on it).
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)'; then
  die "Node.js 20 or newer is required (found: $(node -v 2>/dev/null || echo none)). Install it from https://nodejs.org or with nvm (nvm install 22), then run ./deploy.sh again."
fi
command -v npm >/dev/null 2>&1 || die "npm is required (it ships with Node.js)."

# Pulumi CLI: user-level install into ~/.pulumi/bin.
export PATH="$HOME/.pulumi/bin:$PATH"
command -v pulumi >/dev/null 2>&1 || offer "Pulumi CLI" "curl -fsSL https://get.pulumi.com | sh"
command -v pulumi >/dev/null 2>&1 || die "Pulumi CLI still not found on PATH."

# Azure CLI: Homebrew on macOS; elsewhere it needs a system install, so only print the command.
if ! command -v az >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    offer "Azure CLI" "brew install azure-cli"
  else
    die "Azure CLI is missing. Install it: https://learn.microsoft.com/cli/azure/install-azure-cli (or use Azure Cloud Shell, where it is preinstalled)."
  fi
fi

# npm dependencies: install when missing or when package-lock.json changed.
lock_hash() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum package-lock.json; else shasum -a 256 package-lock.json; fi | cut -d' ' -f1
}
stamp=node_modules/.deploy-lock
if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$(lock_hash)" ]; then
  say "Installing npm dependencies (npm ci)..."
  # --include=dev: the wizard runs on tsx, a devDependency (skipped when NODE_ENV=production).
  npm ci --include=dev --no-audit --no-fund
  lock_hash >"$stamp"
fi

exec node_modules/.bin/tsx wizard/index.ts "$@"
