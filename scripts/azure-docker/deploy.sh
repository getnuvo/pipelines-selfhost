#!/usr/bin/env bash
# Runs on the VM through Azure Run Command on every `pulumi up` that changes its parameters.
# Renders the compose project in /opt/ingestro, pulls secrets from Key Vault with the VM's
# managed identity, then pulls images and (re)starts the stack.
#
# Parameters (env vars):
#   VAULT_NAME          Key Vault name
#   SECRET_MAP          space separated "<dp|mapping>:<ENV_NAME>=<secret-name>" entries
#   COMPOSE_B64         docker-compose.yml (base64)
#   DP_ENV_B64          non-secret dp.env lines (base64)
#   MAPPING_ENV_B64     non-secret mapping.env lines (base64)
#   DP_IMAGE, MAPPING_IMAGE, DP_API_PORT
#   REGISTRY_SERVER     image registry host
#   REGISTRY_AUTH       "acr" (managed identity) or "password" (REGISTRY_USERNAME + registry-password secret)
#   REGISTRY_USERNAME
#   SECRET_VERSIONS     versioned secret ids; only here so a changed secret re-runs this script
#   DEPLOY_NONCE        optional; change it (config deployNonce) to force a re-run
set -euo pipefail

DIR=/opt/ingestro
IMDS=http://169.254.169.254/metadata/identity/oauth2/token

# retry <attempts> <delay-seconds> <command...>
retry() {
  local attempts=$1 delay=$2 attempt
  shift 2
  for attempt in $(seq 1 "$attempts"); do
    "$@" && return 0
    echo "'$1' failed (attempt ${attempt}/${attempts}), retrying in ${delay}s" >&2
    sleep "$delay"
  done
  return 1
}

cloud-init status --wait >/dev/null || true
mountpoint -q /var/lib/docker || {
  echo "data disk is not mounted at /var/lib/docker (cloud-init disk setup failed?)" >&2
  exit 1
}

# cloud-init installs these on first boot, but only if the VM already had egress then
# (spoke peering / firewall rules may come later). Install them here when missing.
ensure_packages() {
  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1 && command -v jq >/dev/null; then
    return 0
  fi
  apt-get update -q &&
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker.io docker-compose-v2 jq curl &&
    systemctl enable --now docker
}
retry 10 30 ensure_packages || {
  echo "could not install docker/jq: no egress to the Ubuntu archive yet? (check spoke peering, UDR and firewall rules)" >&2
  exit 1
}

imds_token() {
  curl -sSf -H Metadata:true "${IMDS}?api-version=2018-02-01&resource=$1" | jq -r .access_token
}

KV_TOKEN=$(imds_token 'https%3A%2F%2Fvault.azure.net')
# Retries only transient failures and 403 (a freshly created role assignment that has not
# propagated yet); anything else (404, 401, ...) fails immediately.
get_secret() {
  local attempt code body
  body=$(mktemp)
  for attempt in $(seq 1 30); do
    code=$(curl -sS -o "$body" -w '%{http_code}' -H "Authorization: Bearer ${KV_TOKEN}" \
      "https://${VAULT_NAME}.vault.azure.net/secrets/$1?api-version=7.4") || true
    code=${code:-000}
    if [ "$code" = "200" ]; then
      jq -er .value "$body"
      rm -f "$body"
      return 0
    fi
    case "$code" in
      403 | 429 | 5?? | 000) ;;
      *)
        echo "Key Vault read of '$1' failed with HTTP ${code}" >&2
        rm -f "$body"
        return 1
        ;;
    esac
    echo "Key Vault read of '$1' returned HTTP ${code} (attempt ${attempt}), retrying" >&2
    sleep 10
  done
  rm -f "$body"
  return 1
}

registry_login() {
  if [ "$REGISTRY_AUTH" = "acr" ]; then
    curl -sSf -X POST "https://${REGISTRY_SERVER}/oauth2/exchange" \
      -d "grant_type=access_token&service=${REGISTRY_SERVER}&access_token=$(imds_token 'https%3A%2F%2Fmanagement.azure.com%2F')" |
      jq -er .refresh_token |
      docker login "$REGISTRY_SERVER" -u 00000000-0000-0000-0000-000000000000 --password-stdin
  else
    get_secret registry-password |
      docker login "$REGISTRY_SERVER" -u "$REGISTRY_USERNAME" --password-stdin
  fi
}

umask 077
install -d -m 700 "$DIR"
echo "$COMPOSE_B64" | base64 -d >"$DIR/docker-compose.yml"
echo "$DP_ENV_B64" | base64 -d >"$DIR/dp.env.tmp"
echo "$MAPPING_ENV_B64" | base64 -d >"$DIR/mapping.env.tmp"

for entry in $SECRET_MAP; do
  file=${entry%%:*}
  rest=${entry#*:}
  var=${rest%%=*}
  name=${rest#*=}
  value=$(get_secret "$name")
  # Compose interpolates `$` in env files; `$$` is a literal `$`.
  printf '%s=%s\n' "$var" "${value//\$/\$\$}" >>"$DIR/$file.env.tmp"
done
mv "$DIR/dp.env.tmp" "$DIR/dp.env"
mv "$DIR/mapping.env.tmp" "$DIR/mapping.env"

printf 'DP_IMAGE=%s\nMAPPING_IMAGE=%s\nDP_API_PORT=%s\n' \
  "$DP_IMAGE" "$MAPPING_IMAGE" "$DP_API_PORT" >"$DIR/.env"

cd "$DIR"
# Retried: an AcrPull role assignment created in the same deployment may still be propagating.
retry 10 15 registry_login
retry 10 15 docker compose pull
docker compose up -d --remove-orphans

services=$(docker compose config --services | sort)
for _ in $(seq 1 40); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q dp-api)" 2>/dev/null || true)
  running=$(docker compose ps --status running --services | sort)
  if [ "$status" = "healthy" ] && [ "$running" = "$services" ]; then
    docker image prune -f >/dev/null
    echo "Ingestro DP is healthy (${DP_IMAGE})"
    exit 0
  fi
  sleep 6
done

echo "Ingestro DP did not become healthy (dp-api: ${status:-unknown})" >&2
docker compose ps >&2
docker compose logs --tail 50 >&2
exit 1
