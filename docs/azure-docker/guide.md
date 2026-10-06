# Ingestro Pipelines Self-host — Azure Private Network

`provider: azure-docker` deploys the Ingestro Pipelines backend inside a **private spoke VNet**:

- DP runs on an **Azure Function App (Linux custom container)**.
- The mapping module runs on a Web App.
- Both are reachable only through Private Endpoints. Nothing gets a public IP and every PaaS resource has public access disabled.
- Users reach the API through your App Gateway, and all egress goes through your Azure Firewall.

Use [`provider: azure`](../azure/guide.md) instead if you want the public Azure Functions deployment.

## What gets deployed (per environment)

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

Subnets: `<prefix>-<environment>-app-subnet` and `<prefix>-<environment>-pe-subnet` (no default outbound access).

## Upgrade and rollback

- **Upgrade:** change `version` (and/or `mappingVersion`), then `pulumi up`. The apps switch to the new image tags (`<version>-functions` for DP).
- **Rollback:** set the previous `version`, then `pulumi up`.

## Prerequisites

### On your side (hub)

- Azure Firewall with a private IP (the UDR next hop), and DNS proxy if you use it.
- Private DNS zones, resolvable from the spoke: either through your DNS proxy (`dnsServers`), or set `linkPrivateDnsZonesToSpoke: true` and the stack links them to the spoke VNet (the deployer needs write access to the zones, also across subscriptions).

  | `privateDnsZoneIds` key | Zone                                 |
  | ----------------------- | ------------------------------------ |
  | `blob`                  | `privatelink.blob.core.windows.net`  |
  | `file`                  | `privatelink.file.core.windows.net`  |
  | `queue`                 | `privatelink.queue.core.windows.net` |
  | `table`                 | `privatelink.table.core.windows.net` |
  | `vault`                 | `privatelink.vaultcore.azure.net`    |
  | `sites`                 | `privatelink.azurewebsites.net`      |

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

After the first `pulumi up`, take the values from `pulumi stack output azureDocker`:

1. **Atlas:** approve the private endpoint, and register `atlasPrivateEndpointId` / `atlasPrivateEndpointIp` in Atlas.
2. **App Gateway**
   - **Backend pool:** `functionAppHostname`. It resolves to `functionAppPrivateEndpointIp` through `privatelink.azurewebsites.net`.
   - **Backend settings:** HTTPS 443, with the host header overridden to `functionAppHostname`.
   - **Health probe:** `GET /dp/api/v1/management/health` (expects 200).
   - **Optional, keep file transfers behind the WAF:**
     - Add a path rule `/blob/*` → rewrite to strip `/blob` → backend `<storageAccountName>.blob.core.windows.net` (the Blob Private Endpoint), HTTPS 443, host header overridden to that name.
     - Then set `blobPublicBaseUrl: https://<your-app-gateway-host>/blob` and run `pulumi up`.
     - SAS signatures don't depend on the host, so the proxied URLs stay valid.
3. **Embeddables:** set `baseUrl` to the App Gateway host only, e.g. `https://ingestro.company.local`.
   - Don't add `/dp`. The SDK appends `/dp/api/v1` itself, so `.../dp` ends in 404s on `/dp/dp/...`.
4. **Access tokens:** your backend requests them from `https://<your-app-gateway-host>/dp/api/v1/access/token` with the license key of that environment. Self-host forwards the request to Ingestro Cloud.

Repeat with a `<customer>-prod` stack and the prod license key.

## Firewall rules

**Inbound**

| From               | To                    | Port                                                       |
| ------------------ | --------------------- | ---------------------------------------------------------- |
| AVD / user subnets | App Gateway           | 443                                                        |
| App Gateway subnet | Function App PE       | 443                                                        |
| AVD / user subnets | Blob Private Endpoint | 443, only without the `/blob` App Gateway rule (see above) |

The Private Endpoint subnet NSG allows the spoke and `appGatewaySubnetCidr` (443). Add the browser subnets to `blobClientCidrs` if you don't proxy Blob through the App Gateway.

**Egress allow-list (from the spoke)**

| FQDN                                                                         | Why                                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| `api-gateway.ingestro.com`                                                   | License verification on every execution              |
| `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com` | Image pulls (not needed with ACR + Private Endpoint) |
| Azure OpenAI endpoint (or its Private Endpoint)                              | Mapping module LLM                                   |
| `*.pusher.com`, `*.pusherapp.com`                                            | Realtime updates, only if `PUSHER_*` is set          |
| `api.brevo.com`                                                              | Email notifications, only if `BREVO_API_KEY` is set  |
| Your data sources / destinations                                             | Pipeline input and output connectors                 |

In the minimal setup (ACR and Azure OpenAI through Private Endpoints, no Pusher or Brevo), the only egress to the internet is `api-gateway.ingestro.com` for license verification. Ingestro does not collect telemetry from self-hosted deployments.

## Operations

- **Logs:** Log Analytics workspace (`logAnalyticsWorkspaceId` output), tables `FunctionAppLogs` and `AppServiceConsoleLogs`.
- **Scaling:** `functionPlanSku`, `functionMaxInstances` and `mappingPlanSku`.
