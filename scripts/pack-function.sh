#!/usr/bin/env bash
set -euo pipefail

# Pack an Azure Functions app folder (default: ./javascript) into a zip archive
# suitable for upload and use via codeArchiveUrl.
#
# Requirements: bash, zip
#
# Usage:
#   scripts/pack-function.sh [-a ./javascript] [-o ./dist/function.zip] [-t] [-v] [-h]
#
# Flags:
#   -a  App path to package (default: ./javascript)
#   -o  Output zip file path (default: ./dist/function.zip)
#   -t  Append timestamp to the output filename (e.g., function-YYYYmmdd-HHMMSS.zip)
#   -v  Verbose zip output
#   -h  Help
#
# Notes:
# - The script zips the contents of the app path directory as the archive root.
# - Excludes: *.DS_Store, *.log, local.settings.json, node_modules/.cache/*

usage() {
  echo "Usage: $0 [-a ./azure-functions] [-o ./dist/azure-functions.zip] [-t] [-v]" >&2
  exit 1
}

APP_PATH="./azure-functions"
OUT_PATH="./dist/azure-functions.zip"
APPEND_TS=0
VERBOSE=0

# Default excludes
EXCLUDE_PATTERNS=("*.DS_Store" "*.log" "local.settings.json" "node_modules/.cache/*")

while [[ $# -gt 0 ]]; do
  case "$1" in
    -a) APP_PATH="$2"; shift 2;;
    -o) OUT_PATH="$2"; shift 2;;
    -t) APPEND_TS=1; shift 1;;
    -v) VERBOSE=1; shift 1;;
    -h|--help) usage;;
    *) echo "Unknown option: $1" >&2; usage;;
  esac
done

if [[ ! -d "$APP_PATH" ]]; then
  echo "Error: app path '$APP_PATH' not found" >&2
  exit 2
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "Error: 'zip' command not found (install zip)" >&2
  exit 3
fi

# Warn if host.json missing (likely incorrect app root)
if [[ ! -f "$APP_PATH/host.json" ]]; then
  echo "Warning: '$APP_PATH/host.json' not found. Ensure this is the Azure Functions app root." >&2
fi

# Compute output path with timestamp if requested
if [[ $APPEND_TS -eq 1 ]]; then
  dir=$(dirname "$OUT_PATH")
  base=$(basename "$OUT_PATH")
  name="${base%.*}"
  ext="${base##*.}"
  ts=$(date +%Y%m%d-%H%M%S)
  OUT_PATH="$dir/${name}-${ts}.${ext}"
fi

# Ensure output directory exists
OUT_DIR_REL=$(dirname "$OUT_PATH")
mkdir -p "$OUT_DIR_REL"

# Resolve absolute output path to ensure zip writes to the intended location even after cd
OUT_FILE=$(basename "$OUT_PATH")
OUT_DIR_ABS=$(cd "$OUT_DIR_REL" && pwd)
OUT_PATH_ABS="$OUT_DIR_ABS/$OUT_FILE"

# Remove any existing file at the absolute path to avoid stale entries
rm -f "$OUT_PATH_ABS"

# Build zip from inside the app directory to avoid nesting the folder
(
  cd "$APP_PATH"
  if [[ $VERBOSE -eq 1 ]]; then
    zip -r "$OUT_PATH_ABS" . -x "${EXCLUDE_PATTERNS[@]}"
  else
    zip -r -q "$OUT_PATH_ABS" . -x "${EXCLUDE_PATTERNS[@]}"
  fi
)

echo "Packed '$APP_PATH' -> '$OUT_PATH_ABS'"
