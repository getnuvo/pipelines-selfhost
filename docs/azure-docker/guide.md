# Ingestro Pipelines Self-host — Azure Private Network

`provider: azure-docker` deploys the Ingestro Pipelines backend inside a **private spoke VNet**. Nothing gets a public IP and every PaaS resource has public access disabled. Users reach the API through your App Gateway, and all egress goes through your Azure Firewall.

Two compute modes (`computeMode`):

| Mode                    | Compute                                                                                                       | When                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `functionapp` (default) | DP on an **Azure Function App (Linux custom container)** + the mapping module on a Web App, Private Endpoints | Managed PaaS, autoscale, no OS to patch                    |
| `vm`                    | DP + mapping with **docker compose on one Linux VM**                                                          | Lower cost; you operate the VM (patching, backups, sizing) |

Use [`provider: azure`](../azure/guide.md) instead if you want the public Azure Functions deployment.

## What gets deployed (per environment)

### `computeMode: functionapp`

```
 AVD / users ─► Azure Firewall ─► App Gateway (WAF) ─┬─► Function App PE :443        (hub: yours)
                                                     └─► /blob/* ─► Blob PE :443 (optional, see blobPublicBaseUrl)
 ┌──────────── Spoke VNet (this stack) ──────────────────────────────────────────────────┐
 │ app subnet  VNet integration (delegated to Microsoft.Web/serverFarms), UDR → firewall    │
 │              Function App  ingestro/pipelines:<version>-functions (Elastic Premium)     │
 │              Mapping Web App  ingestro/mapping:<mappingVersion> (Premium v3)             │
 │ pe subnet   Private Endpoints: Function App · Mapping · Blob · File · Queue · Table ·    │
 │              Key Vault · MongoDB Atlas   (NSG: spoke + App Gateway 443, rest denied)     │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
```

| Resource                | Notes                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Function App            | `<prefix>-<environment>-func`, plan EP1 (`functionPlanSku`), min 1 / max `functionMaxInstances` (3) instances, public access disabled |
| Mapping Web App         | `<prefix>-<environment>-mapping`, plan P1v3 (`mappingPlanSku`), public access disabled                                                |
| App settings            | Secrets are Key Vault references resolved with each app's system-assigned identity                                                    |
| HyperFormula share      | Azure Files share mounted at `/mnt/hyperformula-column` on the Function App (shared by all instances)                                 |
| Storage account         | Public access disabled; blob, file, queue and table Private Endpoints (`AzureWebJobsStorage`, share, data)                            |
| Key Vault               | RBAC, public access disabled, Private Endpoint                                                                                        |
| Log Analytics workspace | Function App and mapping logs through diagnostic settings (Log stream / Kudu are not reachable with public access disabled)           |
| Atlas Private Endpoint  | Azure side only (manual approval in Atlas)                                                                                            |

### `computeMode: vm`

```
 AVD / users ─► Azure Firewall ─► App Gateway (WAF) ─► VM :8080 ──┐   (hub: yours)
 ┌──────────── Spoke VNet (this stack) ───────────────────────────▼──────────────┐
 │ vm subnet  VM (Ubuntu 24.04, docker compose)                                   │
 │            dp-api :8080 · dp-worker · dp-scheduler · mapping                   │
 │            UDR 0.0.0.0/0 → firewall · NSG: 8080 from App Gateway, 22 from admin│
 │ pe subnet  Private Endpoints: Blob · Key Vault · MongoDB Atlas                 │
 └────────────────────────────────────────────────────────────────────────────────┘
```

The VM has no public IP, SSH key only, a system-assigned identity and a data disk at `/var/lib/docker`. A Run Command (`ingestro-deploy`) renders the compose project, reads secrets from Key Vault and (re)starts the containers on every `pulumi up` that changes it.

Subnet names: `<prefix>-<environment>-app-subnet` / `-vm-subnet` and `<prefix>-<environment>-pe-subnet` (no default outbound access).

## How deploy and upgrade work

- **Upgrade:** change `version` (and/or `mappingVersion`), then `pulumi up`.
  - `functionapp`: the apps switch to the new image tags (`<version>-functions` for DP).
  - `vm`: the Run Command pulls the new images and restarts the containers. The VM is not recreated.
- **Rollback:** set the previous `version`, then `pulumi up`.

**`vm` only.** The VM boots as soon as it's created, but the spoke only has egress once you peer it. The deploy script installs Docker itself when cloud-init couldn't, retrying for about 5 minutes. If the first `pulumi up` still fails because packages or images can't be downloaded, peer the spoke and re-run with a new `deployNonce` (also use this after changing a secret directly in Key Vault):

```bash
pulumi config set deployNonce "$(date +%s)" && pulumi up
```

## Prerequisites

### On your side (hub)

- Azure Firewall with a private IP (the UDR next hop), and DNS proxy if you use it.
- Private DNS zones, resolvable from the spoke: either through your DNS proxy (`dnsServers`), or set `linkPrivateDnsZonesToSpoke: true` and the stack links them to the spoke VNet (the deployer needs write access to the zones, also across subscriptions).

  | `privateDnsZoneIds` key | Zone                                 | Needed by     |
  | ----------------------- | ------------------------------------ | ------------- |
  | `blob`                  | `privatelink.blob.core.windows.net`  | both          |
  | `vault`                 | `privatelink.vaultcore.azure.net`    | both          |
  | `file`                  | `privatelink.file.core.windows.net`  | `functionapp` |
  | `queue`                 | `privatelink.queue.core.windows.net` | `functionapp` |
  | `table`                 | `privatelink.table.core.windows.net` | `functionapp` |
  | `sites`                 | `privatelink.azurewebsites.net`      | `functionapp` |

- VNet peering between hub and spoke. This stack does not create peering.
- An App Gateway listener + certificate for your hostname, e.g. `ingestro.company.local`.
- A MongoDB Atlas cluster (MongoDB ≥ 5.0) with Azure Private Link enabled (dedicated tier M10+).
- A DP license key per environment (dev key for Dev, live key for Prod).

### Deployer machine

- Pulumi CLI, Node.js 18+, Azure CLI (`az login`).
- Outbound access to `api-gateway.ingestro.com`, used at deploy time to get the registry key for Docker Hub pulls (not needed with ACR).
- An Azure role that can create resources and role assignments in the subscription (e.g. Owner, or Contributor + User Access Administrator).

## Deploy

```bash
npm install
pulumi stack init <customer>-dev
cp Pulumi.azure-docker.yaml.example Pulumi.<customer>-dev.yaml   # edit values
pulumi config set --secret INGESTRO_LICENSE_KEY <dev-license-key>
pulumi config set --secret MONGO_CONNECTION_STRING '<atlas-private-endpoint-srv>'
pulumi config set --secret S3_CONNECTOR_SECRET_KEY "$(openssl rand -hex 32)"
pulumi config set --secret mappingAzureOpenaiApiKey <key>
pulumi up
```

After the first `pulumi up` (values from `pulumi stack output azureDocker`):

1. **Atlas:** approve the private endpoint and register `atlasPrivateEndpointId` / `atlasPrivateEndpointIp` in Atlas.
2. **App Gateway**
   - `functionapp`:
     - backend pool = `functionAppHostname` (resolves to `functionAppPrivateEndpointIp` through `privatelink.azurewebsites.net`)
     - HTTPS 443, with the host header overridden to `functionAppHostname`
   - `vm`: backend pool = `vmPrivateIp`, HTTP 8080.
   - Health probe `GET /dp/api/v1/management/health` (expects 200).
   - **Optional, keep file transfers behind the WAF:** add a path rule `/blob/*`
     - rewrite: strip the `/blob` prefix
     - backend: `<storageAccountName>.blob.core.windows.net` (Blob Private Endpoint), HTTPS 443, with the host header overridden to that name
     - then set `blobPublicBaseUrl: https://<your-app-gateway-host>/blob` and run `pulumi up`
     - SAS signatures don't depend on the host, so the proxied URLs stay valid
3. **Embeddables:** set `baseUrl` to the App Gateway host only, e.g. `https://ingestro.company.local`. Don't add `/dp`: the SDK appends `/dp/api/v1` itself, and `.../dp` ends in 404s on `/dp/dp/...`.
4. **Access tokens:** your backend requests them from `https://<your-app-gateway-host>/dp/api/v1/access/token` with the license key of that environment. Self-host forwards the request to Ingestro Cloud.

Repeat with a `<customer>-prod` stack and the prod license key.

## Firewall rules

**Inbound**

| From               | To                                               | Port                                                       |
| ------------------ | ------------------------------------------------ | ---------------------------------------------------------- |
| AVD / user subnets | App Gateway                                      | 443                                                        |
| App Gateway subnet | Function App PE (`functionapp`) / VM 8080 (`vm`) | 443 / 8080                                                 |
| AVD / user subnets | Blob Private Endpoint                            | 443, only without the `/blob` App Gateway rule (see above) |
| Admin / Bastion    | VM (`vm` only)                                   | 22                                                         |

In `functionapp` mode the Private Endpoint subnet NSG allows the spoke and `appGatewaySubnetCidr` (443). Add the browser subnets to `blobClientCidrs` if you don't proxy Blob through the App Gateway.

**Egress allow-list (from the spoke)**

| FQDN                                                                         | Why                                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| `api-gateway.ingestro.com`                                                   | License verification on every execution              |
| `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com` | Image pulls (not needed with ACR + Private Endpoint) |
| `archive.ubuntu.com`, `security.ubuntu.com`, `azure.archive.ubuntu.com`      | `vm` only: OS packages and security updates          |
| Azure OpenAI endpoint (or its Private Endpoint)                              | Mapping module LLM                                   |
| `*.pusher.com`, `*.pusherapp.com`                                            | Realtime updates, only if `PUSHER_*` is set          |
| `api.brevo.com`                                                              | Email notifications, only if `BREVO_API_KEY` is set  |
| Your data sources / destinations                                             | Pipeline input and output connectors                 |

With ACR (Private Endpoint), Azure OpenAI (Private Endpoint) and without Pusher/Brevo, the only egress to the internet is `api-gateway.ingestro.com` for license verification. Ingestro does not collect telemetry from self-hosted deployments.

**Azure platform endpoints:** the VM agent (`vm` mode Run Command) and IMDS use `168.63.129.16` and `169.254.169.254`. Azure doesn't route these through the UDR, but an NSG or guest firewall must not block them.

## Operations

`functionapp`:

- **Logs:** Log Analytics workspace (`logAnalyticsWorkspaceId` output), tables `FunctionAppLogs` and `AppServiceConsoleLogs`.
- **Scaling:** `functionPlanSku`, `functionMaxInstances`, `mappingPlanSku`.

`vm`:

```bash
ssh <adminUsername>@<vm-private-ip>              # via Bastion / admin network
sudo docker compose -f /opt/ingestro/docker-compose.yml ps
sudo docker compose -f /opt/ingestro/docker-compose.yml logs -f dp-api dp-worker
df -h /var/lib/docker
```

- Container logs rotate at 5 × 50 MB per service.
- Run exactly one `dp-scheduler`, so that scheduled executions are not triggered twice.
- The VM is a single instance. Data lives in Atlas and Blob, so recovery means redeploying the stack.
