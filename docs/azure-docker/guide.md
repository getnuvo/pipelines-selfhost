# Ingestro Pipelines Self-host — Azure Private Network

`provider: azure-docker` deploys the Ingestro Pipelines backend inside a **private spoke VNet**:

- DP runs on an **Azure Function App (Linux custom container)**; the mapping module runs on a Web App.
- Both apps are reachable only through Private Endpoints. Nothing gets a public IP; public network access is disabled on the apps, the Storage account and the Key Vault.
- Users reach the API through your App Gateway, and all egress from the apps goes through your Azure Firewall.

A wizard, `./deploy.sh`, deploys and updates it, can create a **test hub** for evaluation, walks through the MongoDB Atlas Private Endpoint, and removes everything again.

Use [`provider: azure`](../azure/guide.md) instead for the public Azure Functions deployment.

**Contents**

1. [What gets deployed](#1-what-gets-deployed)
2. [Before you start](#2-before-you-start)
3. [Deploy with the wizard](#3-deploy-with-the-wizard)
4. [Try it with the test hub](#4-try-it-with-the-test-hub)
5. [MongoDB Atlas](#5-mongodb-atlas)
6. [Hand-over to the network admin](#6-hand-over-to-the-network-admin)
7. [Verify](#7-verify)
8. [Operations](#8-operations)
9. [Teardown](#9-teardown)
10. [Batch mode](#10-batch-mode)
11. [Without the wizard](#11-without-the-wizard)
12. [Troubleshooting](#12-troubleshooting)

## 1. What gets deployed

One stack per environment (e.g. `acme-dev`, `acme-prod`):

```
 AVD / users ─► Azure Firewall ─► App Gateway (WAF) ─┬─► Function App PE :443        (hub: yours)
                                                     └─► /blob/* ─► Blob PE :443 (optional)
 ┌──────────── Spoke VNet (this stack) ──────────────────────────────────────────────────┐
 │ app subnet  VNet integration (delegated to Microsoft.Web/serverFarms), UDR → firewall    │
 │              Function App  ingestro/pipelines:<version> (Elastic Premium)               │
 │              Mapping Web App  ingestro/mapping:<mappingVersion> (Premium v3)             │
 │ pe subnet   Private Endpoints: Function App · Mapping · Blob · File · Queue · Table ·    │
 │              Key Vault · MongoDB Atlas   (NSG: spoke + App Gateway 443, rest denied)     │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
```

| Resource                | Notes                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Function App            | Plan EP1, min 1 / max `functionMaxInstances` instances (the wizard sets 2; without it the default is 3), public access disabled |
| Mapping Web App         | Plan P1v3, public access disabled                                                                                               |
| App settings            | Secrets are Key Vault references to the exact secret version, resolved with each app's system-assigned identity                 |
| HyperFormula share      | Azure Files share mounted at `/mnt/hyperformula-column` on the Function App (shared by all instances)                           |
| Storage account         | Public access disabled; blob, file, queue and table Private Endpoints                                                           |
| Key Vault               | RBAC, public access disabled, Private Endpoint                                                                                  |
| Log Analytics workspace | App logs through diagnostic settings (Log stream and Kudu are not reachable with public access disabled)                        |
| Atlas Private Endpoint  | Only with MongoDB Atlas: the Azure side of the Private Link (registered in Atlas, see [MongoDB Atlas](#5-mongodb-atlas))        |

Resource names start with `<prefix>-<environment>-` (e.g. `ingestro-dev-func…`); Azure adds a random suffix to most of them.

## 2. Before you start

### Your machine

- **Node.js 20+**, the **Pulumi CLI** and the **Azure CLI**. `./deploy.sh` checks them and offers to install Pulumi (and the Azure CLI with Homebrew); it works on macOS, Linux, WSL and Azure Cloud Shell.
- `az login` with a role that can create resources and role assignments in the subscription (Owner, or Contributor + User Access Administrator). With an existing hub you also need write access to its Private DNS zones (Private DNS Zone Contributor), also when they are in another subscription.
- Outbound HTTPS to `api-gateway.ingestro.com` (or `api-gateway-develop.ingestro.com` for `dev-*` images): the wizard checks the license there and gets the registry key for the images.

### Azure subscription

App Service quota is per SKU and region, and new or sponsored subscriptions often start at **0**. In the Azure portal, **Quotas → App Service**, for the region you deploy to:

| Quota      | Minimum                                    |
| ---------- | ------------------------------------------ |
| `EP1 VMs`  | `functionMaxInstances` (2 with the wizard) |
| `P1v3 VMs` | 1                                          |

Without it, the deployment fails on the App Service plans with `Operation cannot be completed without additional quota`. The wizard registers the resource providers it needs (after asking).

### License key and images

- One DP license key per environment.
- **Image version and license go together:** `dev-*` images (e.g. `version: dev-0.147.0`, `mappingVersion: 20457-develop`) verify licenses against Ingestro's develop environment and need a dev license key; release images (e.g. `0.147.0`) need a live key. The wizard picks the matching license API from the version.

### Hub

The wizard asks which one you use:

- **Your existing hub** (production): Azure Firewall with a private IP, an App Gateway (WAF), and the six Private DNS zones below. The wizard ends with what the network admin sets up: peering, firewall rules, DNS and App Gateway ([section 6](#6-hand-over-to-the-network-admin)).
- **A test hub** (evaluation only): the wizard deploys it for you ([section 4](#4-try-it-with-the-test-hub)).

| Private DNS zone                     | Used for                                             |
| ------------------------------------ | ---------------------------------------------------- |
| `privatelink.blob.core.windows.net`  | Storage: data and SAS downloads                      |
| `privatelink.file.core.windows.net`  | Storage: Function App content and HyperFormula share |
| `privatelink.queue.core.windows.net` | Storage: Functions runtime                           |
| `privatelink.table.core.windows.net` | Storage: Functions runtime                           |
| `privatelink.vaultcore.azure.net`    | Key Vault                                            |
| `privatelink.azurewebsites.net`      | Function App and mapping app                         |

The deployment's Private Endpoints (Function App, mapping app, Storage, Key Vault) register their addresses in these zones, so they are needed with both DNS options. The Atlas endpoint does not use them ([section 5](#5-mongodb-atlas)).

- **DNS proxy in the hub** (e.g. Azure Firewall DNS proxy): the spoke uses its IP as DNS server; nothing is created in the hub.
- **No DNS proxy:** the deployment links the six zones to the spoke VNet. The zones must already exist.

### Database

- **MongoDB Atlas** (production): a dedicated **M10 or larger** cluster on Azure in the same region, MongoDB ≥ 5.0, a database user with `readWrite` on `ingestro` and `ingestro_logging`, and no public IPs in its access list. See [MongoDB Atlas](#5-mongodb-atlas).
- **Test MongoDB on the jump VM** (test hub only, no auth).
- **Any other connection string** reachable from the spoke through your firewall.

### AI provider (mapping module)

- **Azure OpenAI**: endpoint, deployment name (default `gpt-4o-mini`) and API key. Recommended on Azure: it can be reached through a Private Endpoint.
- **AWS Bedrock**: region, model ID and an access key with `bedrock:InvokeModel`; the spoke needs egress to `bedrock-runtime.<region>.amazonaws.com`.

## 3. Deploy with the wizard

```bash
git clone https://github.com/getnuvo/pipelines-selfhost.git && cd pipelines-selfhost
./deploy.sh
```

The first run checks the tools and installs the npm dependencies, then the wizard asks, section by section:

| Section             | What you answer                                                                                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preflight           | Azure subscription (if you have several). The wizard checks `az login`, the resource providers and the Pulumi login.                                                                                                                   |
| Stack               | Pick a stack or create one (e.g. `acme-dev`). With a local Pulumi backend, stack secrets are encrypted with a **key file** (listed from `~/.pulumi`, generated for a new stack) or a passphrase; the key file is remembered per stack. |
| Stack settings      | Name prefix, environment, Azure region (type to filter).                                                                                                                                                                               |
| Release             | Pipelines and mapping image versions.                                                                                                                                                                                                  |
| License             | The DP license key, verified right away: a wrong key or environment stops here.                                                                                                                                                        |
| Hub                 | Existing hub (firewall private IP, App Gateway subnet, DNS option, the six zones: found in your subscriptions and used automatically when there is exactly one each) or test hub.                                                      |
| Access              | App Gateway URL used as `baseUrl` (optional, can come later), origins of your app for file uploads, and how browsers reach Blob storage: an App Gateway `/blob/*` rule (recommended) or directly from browser subnets.                 |
| Mapping module (AI) | Azure OpenAI or AWS Bedrock, then its settings.                                                                                                                                                                                        |
| Database            | MongoDB Atlas, the test MongoDB, or a connection string.                                                                                                                                                                               |

The spoke layout (`10.20.0.0/16`, app subnet `.1.0/24`, endpoint subnet `.2.0/24`) and the App Service plans (EP1, max 2 instances; P1v3) are not asked; set them in the [answers file](#10-batch-mode) to change them.

Then a **review** of every value (secrets shown as `set`), the **preview** (what will be created), and a confirmation before anything is deployed. At the end the wizard prints the next steps for your hub.

**Run it again any time.** With a complete saved configuration it offers to **resume** (no questions, continue where it stopped, e.g. waiting for Atlas) or to **review and edit** (every question, with the saved values as defaults). `./deploy.sh --preview-only` shows what would change without deploying.

## 4. Try it with the test hub

For evaluation, without a customer hub. Pick **Create a test hub for me** in the Hub section. The wizard also deploys [`test/azure-docker-hub`](../../test/azure-docker-hub/index.ts):

| Part                                                   | Stands in for                       |
| ------------------------------------------------------ | ----------------------------------- |
| NVA VM `10.29.0.4` (IP forwarding + NAT for the spoke) | Azure Firewall                      |
| Jump VM `10.29.2.4` (public IP, SSH from your IP only) | App Gateway and the users' browsers |
| Test MongoDB on the jump VM (no auth)                  | MongoDB (optional)                  |
| The six Private DNS zones, linked to hub and spoke     | Hub DNS                             |

It asks only for your public IP (detected) and an SSH key (from `~/.ssh`, or a new one), deploys the hub, then the spoke, peers them and restarts the apps. One test hub per subscription. If your public IP changes later, the next run offers to update the jump VM's SSH rule.

At the end it prints how to reach the API from your machine:

1. Keep an SSH tunnel through the jump VM open (the wizard prints the exact command):
   ```bash
   ssh -i ~/.ssh/<key> -N -D 1080 ingestro@<jump VM public IP>
   ```
2. Start a browser that uses it (macOS, then Linux):
   ```bash
   open -na "Google Chrome" --args --user-data-dir=/tmp/chrome-ingestro --proxy-server="socks5://localhost:1080"
   ```
   ```bash
   google-chrome --user-data-dir=/tmp/chrome-ingestro --proxy-server="socks5://localhost:1080"
   ```
   On WSL, start Chrome on the Windows side with the same two flags, or any browser set to the SOCKS5 proxy `localhost:1080`.
3. In that browser, open the Ingestro dashboard and set the base URL to `https://<functionAppHostname>` (printed by the wizard). `https://<functionAppHostname>/dp/api/v1/management/health` returns `{"data":{"message":"OK"}}`.

The test hub and the spoke cost money while they run (App Service plans, VMs): remove them with `./deploy.sh destroy` ([section 9](#9-teardown)).

## 5. MongoDB Atlas

You create and operate the Atlas cluster. The deployment creates the Azure side of the Private Endpoint and keeps the connection string in Key Vault. The private connection string only exists once the endpoint is registered in Atlas, so this takes **two rounds**, and the wizard runs both:

1. **In Atlas, before the wizard:** Network Access → Private Endpoint → Dedicated Cluster → **Create endpoint service** (or Add Private Endpoint) → Microsoft Azure → your region. Wait until it is **Available** and copy its **Private Link Service resource ID** (`/subscriptions/…/privateLinkServices/pls_…`).
2. **Wizard, Database section:** pick MongoDB Atlas and paste the Private Link Service ID. The first deployment creates the Private Endpoint.
3. **Wizard prints what to enter in Atlas** (Add Endpoint on that endpoint service):

   | Atlas form                                                                     | Value                                                            |
   | ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
   | Step 1: Resource Group, Virtual Network, Subnet, Private Endpoint name, Region | printed by the wizard (they only fill in Atlas's sample command) |
   | Step 1: `az network private-endpoint create …`                                 | **Do not run it**: the endpoint already exists. Click Next.      |
   | Step 2: Private Endpoint resource ID and IP address                            | printed by the wizard                                            |

4. **Wizard waits** until Atlas approves the endpoint (checks every 20 s). You can stop with Ctrl+C and run `./deploy.sh` again later: **resume** continues here.
5. **Wizard asks for the private connection string:** Atlas → Connect → Private Endpoint → Drivers. Paste it as shown; when it still contains `<db_password>`, the wizard asks for the password and inserts it (URL-encoded). The host must contain `-pl-` (e.g. `cluster-pl-0.abc.mongodb.net`).
6. **Second deployment** stores it; the apps pick up the new secret version right away. The wizard checks that the `-pl-` host resolves to the Private Endpoint IP.

Atlas on Azure serves each node on its own port from **1024 up** (not 27017): any rule between the app subnet and the endpoint subnet must allow that range. Atlas publishes the `-pl-` DNS records itself, so no Private DNS zone is needed for Atlas.

## 6. Hand-over to the network admin

With your existing hub, the wizard ends with this list, filled in with the deployed values.

**1. Peering** between the hub VNet and the spoke VNet (`spokeVnetId`, address space `spokeAddressSpace` in the stack outputs): both directions, forwarded traffic allowed on the hub side. Restart the two apps after the peering and the firewall rules are in place, so they pull their images.

**2. Azure Firewall**

The deployment routes the app subnet's `0.0.0.0/0` to the firewall private IP you entered.

| Inbound from       | To                    | Port                                           |
| ------------------ | --------------------- | ---------------------------------------------- |
| AVD / user subnets | App Gateway           | 443                                            |
| App Gateway subnet | Function App PE       | 443                                            |
| AVD / user subnets | Blob Private Endpoint | 443, only without the `/blob` App Gateway rule |

| Egress from the spoke to                                                     | Why                                                 |
| ---------------------------------------------------------------------------- | --------------------------------------------------- |
| `api-gateway.ingestro.com`                                                   | License verification on every execution             |
| `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com` | Image pulls                                         |
| Azure OpenAI endpoint (or its Private Endpoint)                              | Mapping module LLM                                  |
| `bedrock-runtime.<region>.amazonaws.com`                                     | Mapping module LLM, only with AWS Bedrock           |
| `*.pusher.com`, `*.pusherapp.com`                                            | Realtime updates, only if `PUSHER_*` is set         |
| `api.brevo.com`                                                              | Email notifications, only if `BREVO_API_KEY` is set |
| Your data sources / destinations                                             | Pipeline input and output connectors                |

In the minimal setup (Azure OpenAI through a Private Endpoint, no Pusher or Brevo), the internet egress is the license check and the image pulls. Ingestro does not collect telemetry from self-hosted deployments.

**3. DNS:** with "No DNS proxy" the deployment linked the zones to the spoke. With a DNS proxy, the proxy must resolve the six `privatelink.*` zones (the Private Endpoint records are already in them).

**4. App Gateway**

- **Backend pool:** `functionAppHostname` (resolves to `functionAppPrivateEndpointIp` through `privatelink.azurewebsites.net`).
- **Backend settings:** HTTPS 443, host header overridden to `functionAppHostname`.
- **Health probe:** `GET /dp/api/v1/management/health`, expects 200.
- **Route only `/dp/*` to the Function App.** It also serves internal `/functions/*` routes that DP calls on itself; they must not be reachable through the App Gateway. Return 404 for every other path.
- **Optional, keep file transfers behind the WAF:** a path rule `/blob/*` → strip `/blob` → backend `<storageAccountName>.blob.core.windows.net` (the Blob Private Endpoint), HTTPS 443, host header overridden to that name. Choose this in the wizard's Access section (it sets `blobPublicBaseUrl`); SAS signatures don't depend on the host, so proxied URLs stay valid.

| Path      | Backend                               | Notes                                     |
| --------- | ------------------------------------- | ----------------------------------------- |
| `/dp/*`   | Function App (`functionAppHostname`)  | API + health probe                        |
| `/blob/*` | Blob Private Endpoint (strip `/blob`) | Only with the `/blob` rule                |
| other     | none (404)                            | Keeps `/functions/*` and the root private |

**5. Embeddables and access tokens**

- Set the embeddables' `baseUrl` to the App Gateway host only, e.g. `https://ingestro.company.local`: no `/dp` (the SDK appends `/dp/api/v1`), and not the mapping host. Enter it in the wizard (Access → App Gateway URL) to publish it as `pulumi stack output endpoint`.
- Your backend requests access tokens from `https://<app gateway host>/dp/api/v1/access/token` with the license key of that environment; self-host forwards the request to Ingestro.

## 7. Verify

From a host inside the network (with the test hub: through the SSH tunnel or on the jump VM):

- `curl https://<functionAppHostname>/dp/api/v1/management/health` returns `{"data":{"message":"OK"}}`.
- `functionAppHostname`, `<storageAccountName>.blob.core.windows.net` and `<keyVaultName>.vault.azure.net` resolve to `10.x` addresses.
- From outside the network the same URL returns 403.
- Create a connector and a pipeline in the dashboard and run it; with Atlas, the `ingestro` database appears in Atlas → Browse Collections.

## 8. Operations

- **Upgrade:** `./deploy.sh` → review and edit → new Pipelines / mapping version → deploy. **Rollback:** the same with the previous version.
- **Secrets** (license key, connection string, API keys): change them through the wizard (or `pulumi config set --secret` + `pulumi up`). The apps reference the exact secret version, so they pick up the new one on that deployment; a restart alone does not.
- **Logs:** Log Analytics workspace (`logAnalyticsWorkspaceId` output), tables `FunctionAppLogs` and `AppServiceConsoleLogs`.
- **Scaling:** `functionPlanSku` (EP1–EP3), `functionMaxInstances`, `mappingPlanSku` in the answers file or stack config.

## 9. Teardown

```bash
./deploy.sh destroy                            # pick the stack, see what goes, type its name to confirm
./deploy.sh destroy --stack acme-dev --yes     # no prompts
```

- Removes the stack's resources, and the test hub when the stack uses one (`--keep-hub` keeps it). It retries the transient errors Azure returns while it removes dependent resources.
- **MongoDB Atlas:** it can also remove the Private Endpoint from the Atlas endpoint service, with an Atlas service account (Organization → Access Manager → Service Accounts, Project Owner on the project; in batch mode `ATLAS_CLIENT_ID` / `ATLAS_CLIENT_SECRET`). Otherwise remove it in the Atlas UI. The endpoint service and the cluster stay.
- **Key Vault:** removed with its secrets and kept soft-deleted for 90 days (no cost). Its name has a random suffix, so a new deployment does not collide with it.
- The stack's saved settings are kept (to deploy again) unless you choose to remove them.

## 10. Batch mode

For CI or repeatable setups, without prompts:

```bash
cp deploy.answers.example.yaml acme-dev.answers.yaml   # *.answers.yaml is git-ignored
export INGESTRO_LICENSE_KEY=... AZURE_OPENAI_API_KEY=... MONGO_CONNECTION_STRING=...
./deploy.sh --answers acme-dev.answers.yaml --yes
```

- Keys match the wizard's questions; [`deploy.answers.example.yaml`](../../deploy.answers.example.yaml) lists them with comments. Secrets are `env:VAR_NAME`, so they never sit in the file.
- With a local Pulumi backend, set `pulumiPassphraseFile` (the file must exist) or export `PULUMI_CONFIG_PASSPHRASE`.
- Values already in the stack are kept when a key is left out. Discovered values (e.g. a DNS zone that exists once) are used when not set.
- Exit codes: `2` invalid answers (all reported at once), `3` MongoDB Atlas waits for the endpoint to be registered: register it, set `mongoConnectionString` to the private string, run again. Without `--yes` it stops after the preview.

## 11. Without the wizard

The wizard only writes stack config and runs Pulumi; you can do the same by hand:

```bash
npm ci
pulumi stack init acme-dev
cp Pulumi.azure-docker.yaml.example Pulumi.acme-dev.yaml   # edit the values
pulumi config set --secret INGESTRO_LICENSE_KEY <license-key>
pulumi config set --secret MONGO_CONNECTION_STRING '<connection-string>'
pulumi config set --secret S3_CONNECTOR_SECRET_KEY "$(openssl rand -hex 32)"
pulumi config set --secret mappingAzureOpenaiApiKey <key>
pulumi up
```

For `dev-*` images also set `selfHostDeploymentUrl: https://api-gateway-develop.ingestro.com/dp/api/v1/auth/self-host-deployment`. For Atlas, set `ATLAS_PRIVATE_LINK_SERVICE_ID` with a temporary connection string, `pulumi up`, register `atlasPrivateEndpointId` / `atlasPrivateEndpointIp` (from `pulumi stack output azureDocker`) in Atlas, then set the private connection string and `pulumi up` again ([section 5](#5-mongodb-atlas)). Peering, firewall, DNS and App Gateway as in [section 6](#6-hand-over-to-the-network-admin).

## 12. Troubleshooting

Kudu and Log stream are not reachable with public access disabled. Read the container start log through ARM:

```bash
az rest --method post --url "https://management.azure.com/subscriptions/<sub>/resourceGroups/<resourceGroupName>/providers/Microsoft.Web/sites/<functionAppName>/containerlogs?api-version=2023-12-01"
```

| Symptom                                                                  | Cause and fix                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Operation cannot be completed without additional quota`                 | Request App Service quota ([section 2](#azure-subscription)), then run the wizard again: it continues.                                                                                                                                                                                               |
| `Cannot decrypt the secrets of stack …`                                  | Wrong key file or passphrase for that stack; the wizard asks again. Use the one the stack was created with.                                                                                                                                                                                          |
| License key rejected                                                     | Wrong key, or a dev key with a release image (or the reverse): see [License key and images](#license-key-and-images).                                                                                                                                                                                |
| App returns 503; container log shows `ImagePullFailure` after ~3 minutes | The spoke cannot reach the registry: peering, the firewall egress rules for Docker Hub, or the route to the firewall. Fix it, then restart the apps.                                                                                                                                                 |
| `ImagePullFailure` right away (unauthorized)                             | `DOCKER_REGISTRY_SERVER_PASSWORD` must show **Resolved** under the app's Key Vault references; check the license key.                                                                                                                                                                                |
| Browser: CORS error on API calls                                         | The browser reached the public endpoint (403 without CORS headers) instead of the App Gateway / Private Endpoint. With the test hub: is the SSH tunnel running, is the browser using it?                                                                                                             |
| Browser: `ERR_PROXY_CONNECTION_FAILED` (test hub)                        | The SSH tunnel is not running, or your public IP changed: run `./deploy.sh` (it offers to update the SSH rule), then start the tunnel again.                                                                                                                                                         |
| CORS preflight returns 404 on `/api/v1/...`                              | `baseUrl` points to the mapping app or another host. Use the host that routes `/dp/*` to the Function App.                                                                                                                                                                                           |
| CORS error on file uploads/downloads                                     | Add your app's origin in the Access section (`allowedOrigins`). The Ingestro dashboards are allowed by default.                                                                                                                                                                                      |
| A secret changed in Key Vault outside Pulumi is not picked up            | App Service caches Key Vault references. Change secrets through the wizard, or refresh: `az rest --method post --url "https://management.azure.com/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Web/sites/<app>/config/configreferences/appsettings/refresh?api-version=2022-03-01"`. |
| Atlas connection times out                                               | The Atlas endpoint is not **Available** yet, or a rule blocks ports 1024+ between the app subnet and the endpoint subnet.                                                                                                                                                                            |
| Atlas authentication fails                                               | The connection string still has `<db_password>` or a wrong password: run the wizard, review and edit, paste the string again.                                                                                                                                                                        |
