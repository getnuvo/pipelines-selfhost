# Ingestro Pipelines on Azure — Terraform handoff specification

**For:** the customer's Infrastructure / DevOps team, to build the Ingestro workload in their Terraform modules.
**Status:** draft for review. Open items are listed in [section 12](#12-open-items).

This specification describes everything the Ingestro workload needs in an existing hub-and-spoke network. It is derived from Ingestro's reference implementation (Pulumi, [`src/azure-docker.ts`](../../src/azure-docker.ts)), which we deploy and test end to end on Azure (Function App, Private Endpoints, MongoDB Atlas over Private Link, egress through a firewall). Resource names below are examples; use your own naming convention.

## Contents

1. [Responsibilities](#1-responsibilities)
2. [Architecture and traffic flows](#2-architecture-and-traffic-flows)
3. [Parameters per environment](#3-parameters-per-environment)
4. [Spoke network](#4-spoke-network)
5. [Storage account](#5-storage-account)
6. [Key Vault and secrets](#6-key-vault-and-secrets)
7. [App Service plans and apps](#7-app-service-plans-and-apps)
8. [Container images](#8-container-images)
9. [Application Gateway and WAF](#9-application-gateway-and-waf)
10. [Firewall and DNS](#10-firewall-and-dns)
11. [MongoDB Atlas](#11-mongodb-atlas)
12. [Open items](#12-open-items)
13. [Deployment order, permissions and verification](#13-deployment-order-permissions-and-verification)

## 1. Responsibilities

| Component                                                                                                                                  | Owner                | Notes                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | ---------------------------------------------------------------------------- |
| Hub VNet, Azure Firewall Premium (next hop + DNS proxy), Private DNS zones, peering, AVD                                                   | Customer             | Existing                                                                     |
| Dev and Prod spoke VNets                                                                                                                   | Customer             | Existing; Ingestro needs two subnets in each ([section 4](#4-spoke-network)) |
| Ingestro workload in each spoke: App Service plans, DP Function App, mapping Web App, Storage, Key Vault, Private Endpoints, Log Analytics | Customer (Terraform) | Specified here                                                               |
| Application Gateway listener, backend pool, probe, routing, WAF policy                                                                     | Customer (Terraform) | Specified in [section 9](#9-application-gateway-and-waf)                     |
| MongoDB Atlas clusters and Private Link                                                                                                    | Customer (Terraform) | Baseline in [section 11](#11-mongodb-atlas)                                  |
| Container images, license keys, configuration values                                                                                       | Ingestro             | Images and keys per environment                                              |

## 2. Architecture and traffic flows

```
 AVD session hosts ─► Azure Firewall (hub) ─► App Gateway WAF v2 (hub, private frontend)
                                                   │  /dp/* only
 ┌──────────────── Ingestro spoke (Dev / Prod) ────▼──────────────────────────────────────┐
 │ endpoint subnet   PE: DP Function App ◄── App Gateway                                    │
 │                   PE: Mapping Web App ◄── DP (inside the spoke only)                      │
 │                   PE: Blob · File · Queue · Table · Key Vault · MongoDB Atlas             │
 │ app subnet        VNet integration of both apps; 0.0.0.0/0 → Azure Firewall             │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
```

| #   | From                         | To                                              | Port       | Notes                                                                |
| --- | ---------------------------- | ----------------------------------------------- | ---------- | -------------------------------------------------------------------- |
| 1   | AVD                          | App Gateway private frontend                    | 443        | Users and the embedded Ingestro UI                                   |
| 2   | App Gateway                  | DP Function App Private Endpoint                | 443        | Only `/dp/*`                                                         |
| 3   | DP Function App (app subnet) | DP Function App Private Endpoint                | 443        | DP calls its own internal functions                                  |
| 4   | DP Function App (app subnet) | Mapping Web App Private Endpoint                | 443        | The mapping module is internal to the spoke                          |
| 5   | Both apps (app subnet)       | Storage and Key Vault Private Endpoints         | 443 / 445  | Data, Functions runtime storage, Azure Files mount, secrets          |
| 6   | DP Function App (app subnet) | MongoDB Atlas Private Endpoint                  | 1024–65535 | Atlas on Azure serves each node on its own port                      |
| 7   | Both apps (app subnet)       | Your ACR Private Endpoint                       | 443        | Image pulls with managed identity ([section 8](#8-container-images)) |
| 8   | Both apps (app subnet)       | Internet, through the firewall                  | 443        | License checks, AI provider ([section 10](#10-firewall-and-dns))     |
| 9   | Browsers (AVD)               | Blob Private Endpoint, or App Gateway `/blob/*` | 443        | File uploads/downloads through short-lived SAS URLs                  |

## 3. Parameters per environment

| Parameter                    | Example (Dev)                          | Notes                                                                     |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| Region                       | `germanywestcentral`                   | Same region as the hub and the Atlas cluster                              |
| App subnet                   | `/26` or larger                        | VNet integration of both apps                                             |
| Endpoint subnet              | `/27` or larger                        | Private Endpoints (8–9 IPs)                                               |
| Firewall private IP          | `10.0.0.4`                             | Next hop and DNS server                                                   |
| App Gateway subnet           | `10.0.1.0/24`                          | Only source allowed to reach the DP endpoint on 443                       |
| AVD subnets                  | `10.10.0.0/16`                         | Only for direct Blob access (option B in [section 5](#5-storage-account)) |
| DP image                     | `ingestro/pipelines:<version>`         | From Ingestro per release ([section 8](#8-container-images))              |
| Mapping image                | `ingestro/mapping:<version>`           | From Ingestro per release                                                 |
| DP license key               | secret                                 | Dev key for Dev, live key for Prod                                        |
| MongoDB connection string    | secret                                 | Atlas private endpoint SRV string                                         |
| AI provider                  | Azure OpenAI endpoint, deployment, key | Or AWS Bedrock ([section 7.3](#73-mapping-web-app))                       |
| App Gateway URL              | `https://ingestro-dev.company.local`   | Used as the embeddables' `baseUrl`                                        |
| Origins of your applications | `https://app.company.local`            | Blob CORS, besides the Ingestro dashboards                                |

## 4. Spoke network

**App subnet** (VNet integration)

| Setting                 | Value                                                            |
| ----------------------- | ---------------------------------------------------------------- |
| Delegation              | `Microsoft.Web/serverFarms`                                      |
| Route table             | `0.0.0.0/0` → `VirtualAppliance`, next hop = firewall private IP |
| Default outbound access | Disabled                                                         |

**Endpoint subnet** (Private Endpoints)

| Setting                             | Value                                                 |
| ----------------------------------- | ----------------------------------------------------- |
| `private_endpoint_network_policies` | `Enabled` (so the NSG below applies to the endpoints) |
| Default outbound access             | Disabled                                              |
| NSG                                 | Below                                                 |

| Priority | Name                | Source                      | Destination              | Port    | Access |
| -------- | ------------------- | --------------------------- | ------------------------ | ------- | ------ |
| 100      | allow-spoke         | Spoke address space         | Any                      | Any     | Allow  |
| 110      | allow-appgw-https   | App Gateway subnet          | Any                      | 443/TCP | Allow  |
| 120+     | allow-blob-client-N | AVD subnets (option B only) | ASG of the Blob endpoint | 443/TCP | Allow  |
| 4000     | deny-vnet-inbound   | `VirtualNetwork`            | Any                      | Any     | Deny   |

**Spoke VNet DNS:** custom DNS server = the firewall private IP (DNS proxy), so the spoke resolves the hub's `privatelink.*` zones.

## 5. Storage account

| Setting                  | Value                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------- |
| Kind / SKU               | StorageV2, Standard_LRS                                                               |
| Minimum TLS              | 1.2                                                                                   |
| Allow blob public access | false                                                                                 |
| Public network access    | Disabled; network rules default action Deny                                           |
| Blob container           | one container for pipeline data (e.g. `data`)                                         |
| File share               | `hyperformula` (mounted into the DP Function App, [section 7.2](#72-dp-function-app)) |
| Private Endpoints        | `blob`, `file`, `queue`, `table`, each with a DNS zone group to its hub zone          |

**Blob CORS** (browsers upload and download through SAS URLs):

| Field                     | Value                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowed origins           | `https://dashboard.ingestro.com`, `https://dashboard-staging.ingestro.com`, `https://dashboard-develop.ingestro.com`, plus your applications' origins |
| Allowed methods           | GET, HEAD, POST, PUT, DELETE, OPTIONS                                                                                                                 |
| Allowed / exposed headers | `*`                                                                                                                                                   |
| Max age                   | 3600                                                                                                                                                  |

**How browsers reach Blob storage** (choose one per environment):

- **A. Through the App Gateway (recommended):** a `/blob/*` path rule to the Blob Private Endpoint ([section 9](#9-application-gateway-and-waf)) and the DP setting `AZURE_BLOB_PUBLIC_BASE_URL=https://<app gateway host>/blob`. DP then rewrites SAS URLs to that origin; SAS signatures don't depend on the host.
- **B. Directly:** AVD subnets reach the Blob Private Endpoint on 443. Put the Blob endpoint in an Application Security Group and allow the AVD subnets only to that ASG (NSG priority 120+ above).

## 6. Key Vault and secrets

| Setting               | Value                                                                   |
| --------------------- | ----------------------------------------------------------------------- |
| SKU                   | Standard                                                                |
| Authorization         | Azure RBAC                                                              |
| Public network access | Disabled; network ACL default Deny, bypass AzureServices                |
| Private Endpoint      | `vault`, DNS zone group to `privatelink.vaultcore.azure.net`            |
| Role assignments      | **Key Vault Secrets User** for the system-assigned identity of each app |

| Secret                                                                       | Value                                                                                              | Used by                                                                                                                                   |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `dp-license-key`                                                             | DP license key                                                                                     | DP `DP_LICENSE_KEY`                                                                                                                       |
| `mapping-license-key`                                                        | DP license key (same)                                                                              | Mapping `MAPPING_LICENSE_KEY`                                                                                                             |
| `data-pipeline-db-uri`                                                       | Atlas private SRV connection string                                                                | DP `DATA_PIPELINE_DB_URI`                                                                                                                 |
| `azure-connection-string`                                                    | `DefaultEndpointsProtocol=https;AccountName=<sa>;AccountKey=<key>;EndpointSuffix=core.windows.net` | DP `AZURE_CONNECTION_STRING`, `AzureWebJobsStorage`                                                                                       |
| `azure-account-key`                                                          | Storage account key                                                                                | DP `AZURE_ACCOUNT_KEY`                                                                                                                    |
| `mapping-azure-blob-account-key`                                             | Storage account key                                                                                | Mapping `MAPPING_AZURE_BLOB_ACCOUNT_KEY`                                                                                                  |
| `azure-private-token`                                                        | Random 32 characters                                                                               | DP `AZURE_PRIVATE_TOKEN` (`x-functions-key` for DP's calls to its own functions)                                                          |
| `s3-connector-secret-key`                                                    | Random 32 bytes, hex                                                                               | DP `S3_CONNECTOR_SECRET_KEY` (encrypts stored connector credentials; **keep it stable**, changing it makes stored credentials unreadable) |
| `mapping-azure-openai-api-key`                                               | Azure OpenAI key                                                                                   | Mapping (Azure OpenAI)                                                                                                                    |
| `mapping-aws-bedrock-access-key-id`, `mapping-aws-bedrock-secret-access-key` | AWS keys                                                                                           | Mapping (AWS Bedrock only)                                                                                                                |
| `pusher-secret`, `brevo-api-key`, `sendgrid-receiver-secret-key`             | Optional                                                                                           | Realtime updates / email, only if used                                                                                                    |

**Reference secrets by version** in the app settings: `@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/<name>/<version>)`. App Service caches unversioned references for up to 24 hours, even across restarts; with versioned references a new secret version changes the app setting and is applied immediately. Grant the role before the app settings are applied, so the references resolve on first start.

## 7. App Service plans and apps

### 7.1 Plans

| Plan    | Value                                                                                               |
| ------- | --------------------------------------------------------------------------------------------------- |
| DP      | Linux, Elastic Premium `EP1` (EP1–EP3), `maximum_elastic_worker_count` 2–3, always 1 ready instance |
| Mapping | Linux, Premium v3 `P1v3`                                                                            |

Check **App Service quota** in the region first (Quotas → App Service: `EP1 VMs` ≥ max instances, `P1v3 VMs` ≥ 1); new subscriptions often start at 0.

### 7.2 DP Function App

| Setting                        | Value                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kind                           | `functionapp,linux,container` on the EP plan                                                                                                                             |
| Container                      | `DOCKER\|<registry>/ingestro/pipelines:<version>`                                                                                                                        |
| Identity                       | System-assigned; `key_vault_reference_identity` = SystemAssigned                                                                                                         |
| HTTPS only / HTTP 2 / FTPS     | true / true / Disabled                                                                                                                                                   |
| Public network access          | Disabled                                                                                                                                                                 |
| VNet integration               | App subnet; **route all traffic** (`vnet_route_all_enabled`), **image pull over VNet** (`vnetImagePullEnabled`), **content share over VNet** (`vnetContentShareEnabled`) |
| Minimum elastic instance count | 1                                                                                                                                                                        |
| Private Endpoint               | `sites`, DNS zone group to `privatelink.azurewebsites.net`                                                                                                               |
| Storage mount                  | Azure Files share `hyperformula` at **`/mnt/hyperformula-column`** (account key access); shared by all instances                                                         |
| Diagnostic setting             | `FunctionAppLogs` → Log Analytics workspace (Log stream and Kudu are not reachable with public access disabled)                                                          |

**App settings**

| Name                                                                                                             | Value                                                                                        |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `FUNCTIONS_EXTENSION_VERSION`                                                                                    | `~4`                                                                                         |
| `FUNCTIONS_WORKER_RUNTIME`                                                                                       | `node`                                                                                       |
| `WEBSITES_ENABLE_APP_SERVICE_STORAGE`                                                                            | `false`                                                                                      |
| `AzureWebJobsStorage`                                                                                            | Key Vault reference `azure-connection-string`                                                |
| `CLOUD_PROVIDER`                                                                                                 | `AZURE`                                                                                      |
| `AZURE_FUNCTION_BASE_URL`                                                                                        | `https://<DP Function App default host name>`                                                |
| `MAPPING_BASE_URL`                                                                                               | `https://<Mapping Web App default host name>`                                                |
| `AZURE_ACCOUNT_NAME`                                                                                             | Storage account name                                                                         |
| `AZURE_STORAGE_CONTAINER_NAME`                                                                                   | Blob container name                                                                          |
| `AZURE_BLOB_PUBLIC_BASE_URL`                                                                                     | `https://<app gateway host>/blob` (option A only)                                            |
| `DATA_PIPELINE_DB_NAME`                                                                                          | `ingestro`                                                                                   |
| `DATA_PIPELINE_LOG_DB_NAME`                                                                                      | `ingestro_logging`                                                                           |
| `DP_LICENSE_KEY`                                                                                                 | Key Vault reference `dp-license-key`                                                         |
| `DATA_PIPELINE_DB_URI`                                                                                           | Key Vault reference `data-pipeline-db-uri`                                                   |
| `AZURE_CONNECTION_STRING`                                                                                        | Key Vault reference `azure-connection-string`                                                |
| `AZURE_ACCOUNT_KEY`                                                                                              | Key Vault reference `azure-account-key`                                                      |
| `AZURE_PRIVATE_TOKEN`                                                                                            | Key Vault reference `azure-private-token`                                                    |
| `S3_CONNECTOR_SECRET_KEY`                                                                                        | Key Vault reference `s3-connector-secret-key`                                                |
| `DOCKER_REGISTRY_SERVER_URL`                                                                                     | `https://<acr>.azurecr.io` (AcrPull with managed identity, [section 8](#8-container-images)) |
| `PUSHER_APP_ID`, `PUSHER_KEY`, `PUSHER_SECRET`, `BREVO_API_KEY`, `SENDGRID_RECEIVER_SECRET_KEY`, `CUSTOM_DOMAIN` | Optional (realtime updates, email); leave unset if not used                                  |

### 7.3 Mapping Web App

| Setting                                          | Value                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| Kind                                             | `app,linux,container` on the P1v3 plan                              |
| Container                                        | `DOCKER\|<registry>/ingestro/mapping:<version>`                     |
| Identity, HTTPS, public access, VNet integration | Same as the DP Function App                                         |
| Always on                                        | true                                                                |
| Private Endpoint                                 | `sites`, DNS zone group to `privatelink.azurewebsites.net`          |
| Diagnostic setting                               | `AppServiceConsoleLogs`, `AppServiceHTTPLogs` → Log Analytics       |
| Exposure                                         | **Not** through the App Gateway: only DP calls it, inside the spoke |

**App settings**

| Name                                                                         | Value                                                                                        |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `WEBSITES_PORT`, `MAPPING_PORT`                                              | `8000`                                                                                       |
| `WEBSITES_ENABLE_APP_SERVICE_STORAGE`                                        | `false`                                                                                      |
| `MAPPING_LICENSE_KEY`                                                        | Key Vault reference `mapping-license-key`                                                    |
| `MAPPING_STORAGE_PROVIDER`                                                   | `AZURE_BLOB`                                                                                 |
| `MAPPING_AZURE_BLOB_ACCOUNT_NAME` / `MAPPING_AZURE_BLOB_CONTAINER_NAME`      | Storage account / container (same as DP)                                                     |
| `MAPPING_AZURE_BLOB_ACCOUNT_KEY`                                             | Key Vault reference `mapping-azure-blob-account-key`                                         |
| `MAPPING_LLM_PROVIDER`                                                       | `AZURE` (Azure OpenAI) or `BEDROCK` (AWS Bedrock)                                            |
| `MAPPING_LLM_TEMPERATURE`                                                    | `0`                                                                                          |
| `MAPPING_AZURE_OPENAI_ENDPOINT`                                              | `https://<resource>.openai.azure.com`                                                        |
| `MAPPING_AZURE_OPENAI_API_VERSION`                                           | `2024-10-21`                                                                                 |
| `MAPPING_AZURE_OPENAI_DEPLOYMENT_NAME`                                       | e.g. `gpt-4o-mini`                                                                           |
| `MAPPING_AZURE_OPENAI_API_KEY`                                               | Key Vault reference `mapping-azure-openai-api-key`                                           |
| `MAPPING_AWS_BEDROCK_REGION`, `MAPPING_AWS_BEDROCK_MODEL_ID`                 | Bedrock only (e.g. `anthropic.claude-3-haiku-20240307-v1:0`)                                 |
| `MAPPING_AWS_BEDROCK_ACCESS_KEY_ID`, `MAPPING_AWS_BEDROCK_SECRET_ACCESS_KEY` | Bedrock only, Key Vault references                                                           |
| `DOCKER_REGISTRY_SERVER_URL`                                                 | `https://<acr>.azurecr.io` (AcrPull with managed identity, [section 8](#8-container-images)) |

### 7.4 Log Analytics

One workspace per environment (PerGB2018, e.g. 30 days retention) receiving the diagnostic settings above.

## 8. Container images

| Image                | Tag                          | Notes                                                                   |
| -------------------- | ---------------------------- | ----------------------------------------------------------------------- |
| `ingestro/pipelines` | `<version>` (e.g. `0.147.0`) | Azure Functions host build of DP; Ingestro provides the tag per release |
| `ingestro/mapping`   | `<version>`                  | Pin a concrete tag, never `latest` (rollback)                           |

The DP and mapping images verify the license against Ingestro's API: release images with your **live** key in Prod and your **dev** key in Dev.

**Registry: your Azure Container Registry.** Ingestro publishes each release on Docker Hub; your pipeline imports it into your ACR, and the apps pull from there over the VNet with their managed identities. No egress to a public registry is needed at runtime.

1. **Import each release** (from your CI/CD pipeline or by hand), with the read-only registry key Ingestro provides for your license:

   ```bash
   az acr import --name <acr> --source docker.io/ingestro/pipelines:<version> --image ingestro/pipelines:<version> --username getnuvo --password <registry key>
   az acr import --name <acr> --source docker.io/ingestro/mapping:<version>   --image ingestro/mapping:<version>   --username getnuvo --password <registry key>
   ```

   `az acr import` runs through Azure Resource Manager, so it also works for a registry with public access disabled. The import needs outbound access from the machine or agent that runs it, not from the spokes.

2. **Pull with managed identity:** grant **AcrPull** on the registry to the system-assigned identity of both apps, set `acr_use_managed_identity_credentials = true` in their site config, and the app setting `DOCKER_REGISTRY_SERVER_URL=https://<acr>.azurecr.io` (no username or password).
3. **Network:** the ACR needs a Private Endpoint (`privatelink.azurecr.io`, resolvable from the spokes), since both apps pull images over the VNet (`vnetImagePullEnabled`).
4. **Upgrade:** import the new tags, then change the image tags in your Terraform and apply. **Rollback:** apply the previous tags (keep them in the ACR).

**Registry key:** returned by Ingestro's self-host deployment API for your license (or provided by Ingestro):

```bash
curl -s -X POST https://api-gateway.ingestro.com/dp/api/v1/auth/self-host-deployment \
  -H 'content-type: application/json' \
  -d '{"version":"<version>","provider":"AZURE","license_key":"<license key>"}' | jq -r .docker_key
```

## 9. Application Gateway and WAF

**Backend pool and settings** (one per environment)

| Setting             | Value                                                                                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend target      | FQDN: the **DP Function App default host name** (`<app>.azurewebsites.net`). It resolves to the Private Endpoint IP through `privatelink.azurewebsites.net`, so the App Gateway's DNS must resolve that zone (firewall DNS proxy or zone linked to the hub VNet). |
| Protocol / port     | HTTPS / 443                                                                                                                                                                                                                                                       |
| Host header         | Override with the DP Function App default host name (or "pick host name from backend target")                                                                                                                                                                     |
| Backend certificate | Azure-issued certificate for `*.azurewebsites.net`: use well-known CA certificates                                                                                                                                                                                |
| Request timeout     | 230 s (App Service's front-end limit)                                                                                                                                                                                                                             |

**Health probe**

| Setting                                  | Value                                         |
| ---------------------------------------- | --------------------------------------------- |
| Protocol / host                          | HTTPS / the DP Function App default host name |
| Path                                     | `/dp/api/v1/management/health`                |
| Match                                    | HTTP 200 (body `{"data":{"message":"OK"}}`)   |
| Interval / timeout / unhealthy threshold | 30 s / 30 s / 3                               |

**Routing (path-based rule on the Ingestro listener)**

| Path rule (in this order)                                                                              | Backend                                                                                                        | WAF policy                  | Notes                                                            |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------- |
| `/dp/api/v1/transformation*`, `/dp/api/v1/pipeline*`, `/dp/api/v1/execution*`, `/dp/api/v1/connector*` | DP Function App                                                                                                | `ingestro-data` (see below) | Endpoints that carry user data and transformation code           |
| `/dp/*`                                                                                                | DP Function App                                                                                                | `ingestro-api`              | Everything else: API, health probe, embedded UI calls            |
| `/blob/*`                                                                                              | Blob Private Endpoint `<storage account>.blob.core.windows.net` (HTTPS 443, host header override to that name) | `ingestro-blob`             | Only with Blob option A; needs the rewrite rule below            |
| anything else (the path map default)                                                                   | An **empty backend pool** (App Gateway answers 502) or a redirect to a page of yours; **never the DP backend** | —                           | Keeps the DP internal routes `/functions/*` and the root private |

**Rewrite rule for `/blob/*`** (Blob option A only), attached to the `/blob/*` path rule:

- Condition: `var_uri_path` matches `^/blob(/.*)$` (ignore case).
- URL path: `{var_uri_path_1}` (strips `/blob`), no re-evaluation of the path map.
- **Request header `x-ms-blob-type: BlockBlob`.** Azure Blob rejects a file upload (Put Blob) without it with `400 MissingRequiredHeader`, and uploads through `/blob/*` arrive without it. Downloads (export files) work with the header set.

- **Do not route to the Mapping Web App.** It is internal to the spoke (DP → mapping); exposing it adds attack surface and serves no client.
- **Do not route `/functions/*`.** These are DP's internal function endpoints (called by DP itself with `x-functions-key`).

**Clients**

- Embeddables `baseUrl` = the App Gateway host only, e.g. `https://ingestro-dev.company.local` (no `/dp`; the SDK appends `/dp/api/v1`).
- Your backend requests user access tokens from `https://<app gateway host>/dp/api/v1/access/token` with the environment's license key.

**WAF policies** (measured on 2026-10-09 against App Gateway WAF v2 with `Microsoft_DefaultRuleSet` 2.1: in Detection mode with the dashboard and embedded components, then in Prevention mode with the dashboard and by replaying requests for every API route that carries a body)

Three policies, one per path group, all with the managed rule set `Microsoft_DefaultRuleSet` 2.1. A request the WAF blocks gets a 403 without CORS headers, and query-string matches also block the CORS preflight, so in the browser a WAF block shows up as a CORS error. Without the exclusions, Prevention mode blocks the dashboard as soon as a page loads: every embedded component calls `/component/*/verify` with a cross-origin `meta.origin` and a `session_id`, which scores 10 (threshold 5).

| Policy          | Applies to                | Request body inspection                                          | Other settings                       |
| --------------- | ------------------------- | ---------------------------------------------------------------- | ------------------------------------ |
| `ingestro-api`  | `/dp/*` (everything else) | On, inspect limit and max body 2000 KB, body size enforced       | The eight exclusions below           |
| `ingestro-data` | The four data path rules  | **Off** (`request_body_check = false`, no body size enforcement) | The eight exclusions below           |
| `ingestro-blob` | `/blob/*`                 | **Off** (`request_body_check = false`, no body size enforcement) | Rule **920420** disabled (see below) |

**Why the data paths skip body inspection.** Their bodies are user content by design: spreadsheet rows from the uploaded files (keyed by the file's own column names, so no field-level exclusion can be written in advance), transformation JavaScript and spreadsheet formulas, and AI prompts. In our measurement those requests scored 33 to 78 and tripped rules in the RCE (932100, 932130, 932140), XSS (941320, 941330), SQLI (about 20 rules from 942100 to 942480), LFI (930110), RFI (931130), protocol attack (921130) and MS-ThreatIntel-SQLI (99031001 to 99031004) groups, under field names such as `function`, `prompt`, `cleanings.<row>.<column>` or the column names themselves. Rows larger than 2000 KB (the API accepts up to 6 MB) would also be rejected by the WAF body size limit. On these paths the WAF still inspects the URL, query string and headers, and every endpoint requires an Ingestro access token. Please have your security team review this trade-off.

**Why `/blob/*` disables 920420 and body inspection.** It carries the uploaded file as-is (`.xlsx`, `.csv`, ...) in a raw `PUT` body. Rule 920420 only allows the JSON, XML and form content types and blocks every upload. The body is a file, not inspectable request data, and the 2000 KB body size limit applies to it (the file upload limit only covers multipart forms), so it would reject larger files. Write access needs the short-lived SAS token issued by the API.

**Exclusions** (on `ingestro-api` and `ingestro-data`)

| Match variable    | Operator   | Selector                   | Rule group: rules       | Why                                                                               |
| ----------------- | ---------- | -------------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| `RequestArgNames` | Equals     | `meta.origin`              | RFI: 931130             | The dashboard's origin URL in every component call                                |
| `RequestArgNames` | Equals     | `url`                      | RFI: 931130             | Webhook target URL                                                                |
| `RequestArgNames` | StartsWith | `configuration.`           | RFI: 931130             | Connector source URLs (HTTP URL, OAuth refresh URL)                               |
| `RequestArgKeys`  | Equals     | `session_id`               | FIX: 943110             | Component session ID sent from a cross-origin dashboard                           |
| `RequestArgKeys`  | StartsWith | `filters`                  | SQLI: 942290            | MongoDB-style list filters in the query string, e.g. `filters[$and][0][pipeline]` |
| `RequestArgNames` | Equals     | `options`                  | SQLI: whole group       | JSON-encoded query parameter of `GET /connector/:id/data`                         |
| `RequestArgNames` | StartsWith | `columns.`                 | SQLI, XSS: whole groups | Target data model descriptions, labels, validation regexes                        |
| `RequestArgNames` | StartsWith | `settings.i18n_overrides.` | SQLI, XSS: whole groups | Free-text labels of the embedded components                                       |

If you run OWASP CRS 3.2 instead of the Default Rule Set 2.1, the rule IDs are the same but the group names differ (for example `REQUEST-931-APPLICATION-ATTACK-RFI`); tell us and we re-validate.

**Terraform (azurerm) sketch**

```hcl
locals {
  waf_rule_set = { type = "Microsoft_DefaultRuleSet", version = "2.1" }
  waf_exclusions = [
    { variable = "RequestArgNames", operator = "Equals", selector = "meta.origin", groups = { RFI = ["931130"] } },
    { variable = "RequestArgNames", operator = "Equals", selector = "url", groups = { RFI = ["931130"] } },
    { variable = "RequestArgNames", operator = "StartsWith", selector = "configuration.", groups = { RFI = ["931130"] } },
    { variable = "RequestArgKeys", operator = "Equals", selector = "session_id", groups = { FIX = ["943110"] } },
    { variable = "RequestArgKeys", operator = "StartsWith", selector = "filters", groups = { SQLI = ["942290"] } },
    { variable = "RequestArgNames", operator = "Equals", selector = "options", groups = { SQLI = [] } },
    { variable = "RequestArgNames", operator = "StartsWith", selector = "columns.", groups = { SQLI = [], XSS = [] } },
    { variable = "RequestArgNames", operator = "StartsWith", selector = "settings.i18n_overrides.", groups = { SQLI = [], XSS = [] } },
  ]
  # name => body inspection
  waf_policies = { "ingestro-api" = true, "ingestro-data" = false }
}

resource "azurerm_web_application_firewall_policy" "ingestro" {
  for_each            = local.waf_policies
  name                = each.key
  resource_group_name = var.hub_resource_group_name
  location            = var.location

  policy_settings {
    enabled                          = true
    mode                             = "Prevention"
    request_body_check               = each.value
    request_body_enforcement         = each.value
    request_body_inspect_limit_in_kb = 2000
    max_request_body_size_in_kb      = 2000
    file_upload_limit_in_mb          = 100
  }

  managed_rules {
    managed_rule_set {
      type    = local.waf_rule_set.type
      version = local.waf_rule_set.version
    }

    dynamic "exclusion" {
      for_each = local.waf_exclusions
      content {
        match_variable          = exclusion.value.variable
        selector_match_operator = exclusion.value.operator
        selector                = exclusion.value.selector
        excluded_rule_set {
          type    = local.waf_rule_set.type
          version = local.waf_rule_set.version
          dynamic "rule_group" {
            for_each = exclusion.value.groups
            content {
              rule_group_name = rule_group.key
              # Empty list = the whole group.
              excluded_rules  = length(rule_group.value) > 0 ? rule_group.value : null
            }
          }
        }
      }
    }
  }
}

resource "azurerm_web_application_firewall_policy" "ingestro_blob" {
  name                = "ingestro-blob"
  resource_group_name = var.hub_resource_group_name
  location            = var.location

  policy_settings {
    enabled                  = true
    mode                     = "Prevention"
    request_body_check       = false
    request_body_enforcement = false
  }

  managed_rules {
    managed_rule_set {
      type    = local.waf_rule_set.type
      version = local.waf_rule_set.version
      rule_group_override {
        rule_group_name = "PROTOCOL-ENFORCEMENT"
        rule {
          id      = "920420"
          enabled = false
        }
      }
    }
  }
}

# In azurerm_application_gateway:
#   backend_address_pool { name = "ingestro-none" }  # no targets
#   url_path_map { default_backend_address_pool_name = "ingestro-none", default_backend_http_settings_name = "ingestro-dp", ...
#     path_rule { name = "ingestro-data", paths = ["/dp/api/v1/transformation*", "/dp/api/v1/pipeline*", "/dp/api/v1/execution*", "/dp/api/v1/connector*"],
#                 backend_address_pool_name = "ingestro-dp", backend_http_settings_name = "ingestro-dp",
#                 firewall_policy_id = azurerm_web_application_firewall_policy.ingestro["ingestro-data"].id }
#     path_rule { name = "ingestro-api", paths = ["/dp/*"], ..., firewall_policy_id = azurerm_web_application_firewall_policy.ingestro["ingestro-api"].id }
#     path_rule { name = "ingestro-blob", paths = ["/blob/*"], ..., rewrite_rule_set_name = "ingestro-blob",
#                 firewall_policy_id = azurerm_web_application_firewall_policy.ingestro_blob.id }
#   }
#   rewrite_rule_set { name = "ingestro-blob"
#     rewrite_rule { name = "strip-blob", rule_sequence = 100
#       condition { variable = "var_uri_path", pattern = "^/blob(/.*)$", ignore_case = true }
#       request_header_configuration { header_name = "x-ms-blob-type", header_value = "BlockBlob" }
#       url { path = "{var_uri_path_1}", reroute = false }
#     }
#   }
```

Start in Detection mode if you prefer, check `AGWFirewallLogs` during your acceptance test, then switch to Prevention. Send us any `Matched` entries on Ingestro paths that are not covered here (rule ID, request URI, `DetailedData`), and we extend the list.

## 10. Firewall and DNS

**Egress allow-list from the Ingestro spokes** (application rules, HTTPS 443)

| FQDN                                            | Why                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `api-gateway.ingestro.com`                      | License verification on every execution, user access tokens (`api-gateway-develop.ingestro.com` for `dev-*` images) |
| Azure OpenAI endpoint (or its Private Endpoint) | Mapping module                                                                                                      |
| `bedrock-runtime.<region>.amazonaws.com`        | Mapping module, only with AWS Bedrock                                                                               |
| `*.pusher.com`, `*.pusherapp.com`               | Only if Pusher is configured                                                                                        |
| `api.brevo.com`                                 | Only if Brevo is configured                                                                                         |
| Your pipeline data sources and destinations     | Input and output connectors                                                                                         |

Docker Hub is not on this list: the apps pull from your ACR ([section 8](#8-container-images)), and only the import pipeline reaches Docker Hub.

Ingestro does not collect telemetry from self-hosted deployments.

**DNS**

- Every Private Endpoint registers its A record in the hub zone through its DNS zone group: `privatelink.blob/file/queue/table.core.windows.net`, `privatelink.vaultcore.azure.net`, `privatelink.azurewebsites.net` (app and `scm` records), and `privatelink.azurecr.io` for your ACR.
- The spoke resolves through the firewall DNS proxy; the App Gateway must resolve `privatelink.azurewebsites.net` as well.
- MongoDB Atlas publishes its `<cluster>-pl-0.<id>.mongodb.net` records in public DNS pointing at the endpoint's private IP: no Private DNS zone is needed for Atlas, but the DNS proxy must forward public lookups.

## 11. MongoDB Atlas

Recommended baseline:

| Item          | Recommendation                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Tier          | Dedicated M10 or larger (required for Private Link). M10 for Dev; size Prod by pipeline volume, with Atlas auto-scaling enabled. |
| Topology      | The default 3-node replica set; no sharding needed.                                                                              |
| Version       | MongoDB 5.0 or later.                                                                                                            |
| Region        | Azure, same region as the spoke.                                                                                                 |
| Databases     | `ingestro` and `ingestro_logging` (names configurable through `DATA_PIPELINE_DB_NAME` / `DATA_PIPELINE_LOG_DB_NAME`).            |
| Database user | `readWrite` on both databases; password authentication.                                                                          |
| Indexes       | Created by the application on startup; nothing to pre-create.                                                                    |
| Network       | Private Link only: no IP access list entries.                                                                                    |
| Backups       | Your Atlas backup policy (cloud backups recommended for Prod).                                                                   |

**Private Link with Terraform:** an Atlas endpoint service for Azure in the region (`mongodbatlas_privatelink_endpoint`), an `azurerm_private_endpoint` in the Ingestro endpoint subnet with a **manual** connection to the endpoint service's Private Link Service, and the endpoint registration in Atlas (`mongodbatlas_privatelink_endpoint_service` with the Azure endpoint ID and IP). The DP connection string is the **private endpoint SRV string** (`mongodb+srv://<user>:<password>@<cluster>-pl-0.<id>.mongodb.net/?retryWrites=true&w=majority`), stored as the `data-pipeline-db-uri` secret. The NSG rules above already allow the spoke to reach the endpoint on ports 1024 and up.

## 12. Open items

| #   | Item                                                                                             | Owner                   | Status                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | WAF exclusion rule IDs for the upload / payload endpoints (and `/blob/*` if used)                | Ingestro                | **Done:** see [section 9](#9-application-gateway-and-waf); your security team to accept the data-path trade-off |
| 2   | Image source                                                                                     | Customer, with Ingestro | **Decided:** your ACR (import from Docker Hub with the registry key)                                            |
| 3   | Release versions of `ingestro/pipelines` and `ingestro/mapping`, and the live / dev license keys | Ingestro                | Per release                                                                                                     |
| 4   | Blob access option A (App Gateway `/blob/*`) or B (direct from AVD)                              | Customer                | To confirm                                                                                                      |
| 5   | AI provider for the mapping module (Azure OpenAI recommended)                                    | Customer                | To confirm                                                                                                      |

## 13. Deployment order, permissions and verification

**Order**

1. Subnets, route table, NSG and ASG in the spoke; spoke DNS server = firewall IP.
2. Storage account (container, file share, CORS), Key Vault, Log Analytics; their Private Endpoints and DNS zone groups.
3. Atlas endpoint service, the Atlas Private Endpoint, its registration in Atlas.
4. App Service plans; both apps with system-assigned identities, VNet integration and their Private Endpoints.
5. Role assignments (Key Vault Secrets User, AcrPull), then the Key Vault secrets and the app settings (versioned references) and the Azure Files mount.
6. Firewall rules, App Gateway backend / probe / routing / WAF policy.

**Permissions for the deploying service principal** (least privilege): create resources in the Ingestro resource group; assign roles scoped to the Key Vault and the ACR for the apps' identities; join the spoke subnets; write records in the hub Private DNS zones (`Microsoft.Network/privateDnsZones/join/action`, e.g. Private DNS Zone Contributor on those zones). Writing Key Vault secrets through ARM works with the vault's public access disabled.

**Verification**

- From an AVD session host: `https://<app gateway host>/dp/api/v1/management/health` returns `{"data":{"message":"OK"}}`.
- Inside the network, the app, Storage and Key Vault host names resolve to `10.x` addresses; from outside, the Function App returns 403.
- Both apps show their Key Vault references as **Resolved** and the containers start (Log Analytics `FunctionAppLogs`, `AppServiceConsoleLogs`).
- In the Ingestro UI (base URL = App Gateway host): create a connector and a pipeline and run it; data appears in Atlas (`ingestro` database).
