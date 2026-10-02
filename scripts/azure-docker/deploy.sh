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
set -euo pipefail

DIR=/opt/ingestro
IMDS=http://169.254.169.254/metadata/identity/oauth2/token

cloud-init status --wait >/dev/null || true
command -v docker >/dev/null || {
  echo "docker is not installed (cloud-init failed?)" >&2
  exit 1
}

imds_token() {
  curl -sSf -H Metadata:true "${IMDS}?api-version=2018-02-01&resource=$1" | jq -r .access_token
}

KV_TOKEN=$(imds_token 'https%3A%2F%2Fvault.azure.net')
# Retries cover a freshly created role assignment that has not propagated yet (403).
get_secret() {
  local attempt
  for attempt in $(seq 1 30); do
    if curl -sSf -H "Authorization: Bearer ${KV_TOKEN}" \
      "https://${VAULT_NAME}.vault.azure.net/secrets/$1?api-version=7.4" | jq -er .value; then
      return 0
    fi
    echo "Key Vault read of '$1' failed (attempt ${attempt}), retrying" >&2
    sleep 10
  done
  return 1
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
  printf '%s=%s\n' "$var" "$value" >>"$DIR/$file.env.tmp"
done
mv "$DIR/dp.env.tmp" "$DIR/dp.env"
mv "$DIR/mapping.env.tmp" "$DIR/mapping.env"

printf 'DP_IMAGE=%s\nMAPPING_IMAGE=%s\nDP_API_PORT=%s\n' \
  "$DP_IMAGE" "$MAPPING_IMAGE" "$DP_API_PORT" >"$DIR/.env"

if [ "$REGISTRY_AUTH" = "acr" ]; then
  ARM_TOKEN=$(imds_token 'https%3A%2F%2Fmanagement.azure.com%2F')
  curl -sSf -X POST "https://${REGISTRY_SERVER}/oauth2/exchange" \
    -d "grant_type=access_token&service=${REGISTRY_SERVER}&access_token=${ARM_TOKEN}" |
    jq -r .refresh_token |
    docker login "$REGISTRY_SERVER" -u 00000000-0000-0000-0000-000000000000 --password-stdin
else
  get_secret registry-password |
    docker login "$REGISTRY_SERVER" -u "$REGISTRY_USERNAME" --password-stdin
fi

cd "$DIR"
docker compose pull
docker compose up -d --remove-orphans

for _ in $(seq 1 40); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q dp-api)" 2>/dev/null || true)
  if [ "$status" = "healthy" ]; then
    docker image prune -f >/dev/null
    echo "Ingestro DP is healthy (${DP_IMAGE})"
    exit 0
  fi
  sleep 6
done

echo "dp-api did not become healthy" >&2
docker compose ps >&2
docker compose logs --tail 50 dp-api dp-worker >&2
exit 1
