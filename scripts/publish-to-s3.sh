#!/usr/bin/env bash
set -euo pipefail

# Zip ./javascript (or custom path), upload to S3, generate a presigned URL, and optionally set Pulumi config.
# Requirements: bash, zip, AWS CLI v2, Pulumi CLI (optional for --set-pulumi)
#
# Usage:
#   scripts/publish-to-s3.sh -b <bucket> [-k function.zip] [-e 3600] [-a ./javascript] [-r <region>] [-t] [--set-pulumi] [-S dev] [--dry-run]
#
# Flags:
#   -b  S3 bucket name (required)
#   -k  S3 object key (default: function.zip)
#   -e  Presign expiration in seconds (default: 3600)
#   -a  App path to package (default: ./javascript)
#   -r  AWS region (optional; else AWS CLI default)
#   -t  Append timestamp to key (function-YYYYmmdd-HHMMSS.zip)
#   -S  Pulumi stack name to target when setting config (optional)
#   --set-pulumi  Set Pulumi config pulumi-azure-function:codeArchiveUrl with the presigned URL (as secret)
#   --dry-run     Do everything except the actual S3 upload and presign; prints a mock URL
#
# Examples:
#   scripts/publish-to-s3.sh -b my-bucket -k function.zip -e 7200 --set-pulumi -S dev
#   scripts/publish-to-s3.sh -b my-bucket -t -a ./javascript --dry-run

usage() {
  echo "Usage: $0 -b <bucket> [-k function.zip] [-e 3600] [-a ./javascript] [-r <region>] [-t] [--set-pulumi] [-S dev] [--dry-run]" >&2
  exit 1
}

# Defaults
BUCKET=""
KEY="function.zip"
EXPIRES=3600
APP_PATH="./javascript"
REGION=""
APPEND_TS=0
SET_PULUMI=0
STACK_NAME=""
DRY_RUN=0

# Parse args
TEMP_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -b) BUCKET="$2"; shift 2;;
    -k) KEY="$2"; shift 2;;
    -e) EXPIRES="$2"; shift 2;;
    -a) APP_PATH="$2"; shift 2;;
    -r) REGION="$2"; shift 2;;
    -t) APPEND_TS=1; shift 1;;
    -S) STACK_NAME="$2"; shift 2;;
    --set-pulumi) SET_PULUMI=1; shift 1;;
    --dry-run) DRY_RUN=1; shift 1;;
    -h|--help) usage;;
    *) TEMP_ARGS+=("$1"); shift 1;;
  esac
done
# Only reset positional params if we actually captured unknown args
if [[ ${#TEMP_ARGS[@]} -gt 0 ]]; then
  set -- "${TEMP_ARGS[@]}"
fi

if [[ -z "$BUCKET" ]]; then
  echo "Error: -b <bucket> is required" >&2
  usage
fi

if [[ ! -d "$APP_PATH" ]]; then
  echo "Error: app path '$APP_PATH' not found" >&2
  exit 2
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "Error: 'zip' is required (brew install zip)" >&2
  exit 3
fi

if [[ $DRY_RUN -eq 0 ]]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "Error: AWS CLI is required (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)" >&2
    exit 4
  fi
fi

if [[ $SET_PULUMI -eq 1 ]] && ! command -v pulumi >/dev/null 2>&1; then
  echo "Error: Pulumi CLI is required for --set-pulumi (https://www.pulumi.com/docs/install/)" >&2
  exit 5
fi

# Derive key with timestamp if requested
if [[ $APPEND_TS -eq 1 ]]; then
  TS=$(date +%Y%m%d-%H%M%S)
  BASE="${KEY%.zip}"
  KEY="${BASE}-${TS}.zip"
fi

# Create temp zip file
TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'publish-s3')
ZIP_PATH="$TMP_DIR/$KEY"

# Sanity: look for host.json in app root to warn if structure may be wrong
if [[ ! -f "$APP_PATH/host.json" ]]; then
  echo "Warning: '$APP_PATH/host.json' not found. Ensure the archive root contains your Azure Functions app (host.json, function folders)." >&2
fi

# Build the zip (from inside APP_PATH to avoid nesting the folder itself)
(
  cd "$APP_PATH"
  # Exclude common local/dev files
  zip -r -q "$ZIP_PATH" . -x "*.DS_Store" "*.log" "node_modules/.cache/*" "local.settings.json"
)

S3_URI="s3://$BUCKET/$KEY"

# Upload to S3
if [[ $DRY_RUN -eq 1 ]]; then
  echo "[DRY-RUN] Would upload $ZIP_PATH to $S3_URI"
else
  if [[ -n "$REGION" ]]; then
    aws s3 cp "$ZIP_PATH" "$S3_URI" --region "$REGION"
  else
    aws s3 cp "$ZIP_PATH" "$S3_URI"
  fi
fi

# Generate a presigned URL
PRESIGNED_URL=""
if [[ $DRY_RUN -eq 1 ]]; then
  PRESIGNED_URL="https://$BUCKET.s3.amazonaws.com/$KEY?X-Amz-Signature=DRYRUN"
  echo "[DRY-RUN] Would presign $S3_URI for $EXPIRES seconds"
else
  if [[ -n "$REGION" ]]; then
    PRESIGNED_URL=$(aws s3 presign "$S3_URI" --expires-in "$EXPIRES" --region "$REGION")
  else
    PRESIGNED_URL=$(aws s3 presign "$S3_URI" --expires-in "$EXPIRES")
  fi
fi

echo "Presigned URL (expires in $EXPIRES s):"
echo "$PRESIGNED_URL"

# Optionally set Pulumi config
if [[ $SET_PULUMI -eq 1 ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[DRY-RUN] Would run: pulumi config set --secret pulumi-azure-function:codeArchiveUrl '<URL>' ${STACK_NAME:+--stack $STACK_NAME}"
  else
    CMD=(pulumi config set --secret pulumi-azure-function:codeArchiveUrl "$PRESIGNED_URL")
    if [[ -n "$STACK_NAME" ]]; then
      CMD+=(--stack "$STACK_NAME")
    fi
    "${CMD[@]}"
    echo "Pulumi config 'pulumi-azure-function:codeArchiveUrl' set${STACK_NAME:+ for stack '$STACK_NAME'}."
  fi
fi

echo "Done."
