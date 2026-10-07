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
 │              Function App  ingestro/pipelines:<version> (Elastic Premium)               │
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

- **Upgrade:** change `version` (and/or `mappingVersion`), then `pulumi up`. The apps switch to the new image tags (`ingestro/pipelines:<version>`, `ingestro/mapping:<mappingVersion>`).
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
- A MongoDB Atlas cluster per environment, managed by you (see [MongoDB Atlas](#mongodb-atlas)).
- A DP license key per environment (dev key for Dev, live key for Prod).

### Subscription quota

App Service quota is per SKU and region, and new or sponsored subscriptions often start at 0. Check **Quotas → App Service** for the stack's region and request at least:

| Quota      | Minimum                            |
| ---------- | ---------------------------------- |
| `EP1 VMs`  | `functionMaxInstances` (default 3) |
| `P1v3 VMs` | 1                                  |

Use the SKU you set in `functionPlanSku` / `mappingPlanSku` if you changed them. Without quota, `pulumi up` fails on the App Service plans with `Operation cannot be completed without additional quota`.

### Deployer machine

- Pulumi CLI, Node.js 18+, Azure CLI (`az login`).
- Outbound access to `api-gateway.ingestro.com`, used at deploy time to get the registry key for Docker Hub pulls (not needed with ACR).
- An Azure role that can create resources and role assignments in the subscription (e.g. Owner, or Contributor + User Access Administrator).

## MongoDB Atlas

You create and operate the Atlas clusters; this stack creates the Azure side of the Private Endpoint and stores the connection string in Key Vault.

**Requirements**

- One cluster per environment (Dev, Prod), MongoDB ≥ 5.0, on Azure in the same region as the stack (`location`).
- A **dedicated tier, M10 or larger**: Atlas Private Link is not available on free, Flex or serverless clusters.
- A database user with `readWrite` on the databases set in `DB_NAME` (default `ingestro`) and `LOG_DB_NAME` (default `ingestro_logging`).
- No public IPs in the cluster's IP access list: Ingestro connects only through the Private Endpoint.

**Steps (per environment)**

1. In Atlas, open **Network Access → Private Endpoint → Dedicated cluster → Microsoft Azure**, pick the region, and copy the **Private Link Service resource ID** it shows.
2. Set it in the stack, plus a temporary connection string (Pulumi needs one on the first run; the standard SRV string is fine):

   ```bash
   pulumi config set ATLAS_PRIVATE_LINK_SERVICE_ID '<private-link-service-resource-id>'
   pulumi config set --secret MONGO_CONNECTION_STRING '<temporary-srv-string>'
   pulumi up
   ```

3. Back in Atlas, click **Add Endpoint** and finish it with `atlasPrivateEndpointId` (the Azure Private Endpoint resource ID) and `atlasPrivateEndpointIp` from `pulumi stack output azureDocker`. Skip the `az network private-endpoint create` command Atlas shows; this stack already created the endpoint. Wait until the endpoint is **Available**.
4. In Atlas, **Connect → Private Endpoint → Drivers**, copy the private endpoint SRV string (`mongodb+srv://<cluster>-pl-0.<id>.mongodb.net/...`) with the database user, then:

   ```bash
   pulumi config set --secret MONGO_CONNECTION_STRING '<private-endpoint-srv-string>'
   pulumi up
   ```

   The app settings reference the exact secret version, so `pulumi up` points them at the new version and App Service restarts with it. No manual restart is needed.

5. Check from inside the network (e.g. a jump host in a peered subnet) that the `-pl-0` host name resolves to `atlasPrivateEndpointIp`. Atlas publishes these DNS records from the IP you registered in step 3, so no Private DNS zone is needed on your side. Atlas on Azure serves each node on its own port from 1024 up (not 27017), so any rule between the app subnet and the endpoint subnet must allow that range.

## Deploy

```bash
npm install
pulumi stack init <customer>-dev
cp Pulumi.azure-docker.yaml.example Pulumi.<customer>-dev.yaml   # edit values
pulumi config set --secret INGESTRO_LICENSE_KEY <dev-license-key>
pulumi config set --secret MONGO_CONNECTION_STRING '<atlas-srv-string>'   # see MongoDB Atlas
pulumi config set --secret S3_CONNECTOR_SECRET_KEY "$(openssl rand -hex 32)"
pulumi config set --secret mappingAzureOpenaiApiKey <key>
pulumi up
```

After the first `pulumi up`, take the values from `pulumi stack output azureDocker`:

1. **Atlas:** finish the Private Endpoint and switch to the private connection string (steps 3–4 in [MongoDB Atlas](#mongodb-atlas)).
2. **App Gateway**
   - **Backend pool:** `functionAppHostname`. It resolves to `functionAppPrivateEndpointIp` through `privatelink.azurewebsites.net`.
   - **Backend settings:** HTTPS 443, with the host header overridden to `functionAppHostname`.
   - **Health probe:** `GET /dp/api/v1/management/health` (expects 200).
   - **Route only `/dp/*` to the Function App.** The app also serves internal `/functions/*` routes that DP calls on itself (protected by a token); they must not be reachable through the App Gateway. Return 404 (or a redirect) for every other path.
   - **Optional, keep file transfers behind the WAF:**
     - Add a path rule `/blob/*` → rewrite to strip `/blob` → backend `<storageAccountName>.blob.core.windows.net` (the Blob Private Endpoint), HTTPS 443, host header overridden to that name.
     - Then set `blobPublicBaseUrl: https://<your-app-gateway-host>/blob` and run `pulumi up`.
     - SAS signatures don't depend on the host, so the proxied URLs stay valid.

   | Path      | Backend                               | Notes                                     |
   | --------- | ------------------------------------- | ----------------------------------------- |
   | `/dp/*`   | Function App (`functionAppHostname`)  | API + health probe                        |
   | `/blob/*` | Blob Private Endpoint (strip `/blob`) | Only with `blobPublicBaseUrl`             |
   | other     | none (404)                            | Keeps `/functions/*` and the root private |

3. **Embeddables:** set `baseUrl` to the App Gateway host only, e.g. `https://ingestro.company.local`.
   - Set the same value as `apiBaseUrl` and run `pulumi up` to publish it as `pulumi stack output endpoint`. Without it, `endpoint` stays empty, because the Function App URL is private.
   - Don't add `/dp`. The SDK appends `/dp/api/v1` itself, so `.../dp` ends in 404s on `/dp/dp/...`.
   - Use the Function App (through the App Gateway), not `mappingAppHostname`. The mapping module is called by DP only.
4. **Access tokens:** your backend requests them from `https://<your-app-gateway-host>/dp/api/v1/access/token` with the license key of that environment. Self-host forwards the request to Ingestro Cloud.

5. **Verify** from a host inside the network (e.g. a jump host in a peered subnet):
   - `curl https://<functionAppHostname>/dp/api/v1/management/health` returns `{"data":{"message":"OK"}}`.
   - `functionAppHostname`, `<storageAccountName>.blob.core.windows.net` and `<keyVaultName>.vault.azure.net` resolve to `10.x` addresses (the Private Endpoint IPs).
   - From outside the network, the same URL returns 403.

Repeat with a `<customer>-prod` stack and the prod license key.

## Teardown

```bash
pulumi destroy
```

- Key Vault secrets are removed together with the vault (Pulumi does not delete them one by one, because the vault's data plane is private). The vault stays soft-deleted for 90 days; its name has a random suffix, so a new deployment does not collide with it.
- In Atlas, remove the Private Endpoint from the endpoint service. The cluster itself is yours to keep or delete.

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

## Troubleshooting

Kudu and Log stream are not reachable with public access disabled. Read the container start log through ARM instead:

```bash
az rest --method post --url "https://management.azure.com/subscriptions/<sub>/resourceGroups/<resourceGroupName>/providers/Microsoft.Web/sites/<functionAppName>/containerlogs?api-version=2023-12-01"
```

| Symptom                                                                  | Cause and fix                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App returns 503; container log shows `ImagePullFailure` after ~3 minutes | The spoke cannot reach the registry. Allow the Docker Hub FQDNs (see [Egress allow-list](#firewall-rules)) on the firewall, check the UDR next hop and that the firewall accepts traffic from the spoke, then `az functionapp restart`.                                                                                                                                                                                           |
| `ImagePullFailure` right away (unauthorized)                             | Registry credentials. Check that `DOCKER_REGISTRY_SERVER_PASSWORD` shows **Resolved** under the app's Key Vault references, and that the license key is valid for the environment.                                                                                                                                                                                                                                                |
| Browser shows a CORS error on API calls                                  | Usually the browser reached the public endpoint (403 without CORS headers) instead of the App Gateway / Private Endpoint. The API itself allows any origin.                                                                                                                                                                                                                                                                       |
| CORS error on file uploads/downloads                                     | Add the app's origin to `allowedOrigins` (Blob CORS). The Ingestro dashboards are allowed by default.                                                                                                                                                                                                                                                                                                                             |
| CORS preflight returns 404 on `/api/v1/...` (no `/dp`)                   | `baseUrl` points to the mapping app or another host. Use the App Gateway host that routes `/dp/*` to the Function App.                                                                                                                                                                                                                                                                                                            |
| A secret changed in Key Vault outside Pulumi is not picked up            | App Service caches Key Vault references. Change secrets through `pulumi config set --secret` + `pulumi up` (the apps reference the exact version), or force a refresh: `az rest --method post --url "https://management.azure.com/subscriptions/<sub>/resourceGroups/<resourceGroupName>/providers/Microsoft.Web/sites/<app>/config/configreferences/appsettings/refresh?api-version=2022-03-01"`. A restart alone is not enough. |
| Atlas connection times out                                               | The Atlas endpoint is not **Available** yet, or a rule blocks ports 1024+ between the app subnet and the endpoint subnet (see [MongoDB Atlas](#mongodb-atlas) step 5).                                                                                                                                                                                                                                                            |
