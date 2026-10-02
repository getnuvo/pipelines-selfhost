# Ingestro Pipelines Self-host — Azure VM + Docker Compose (Private Network)

`provider: azure-docker` deploys the Ingestro Pipelines backend on a Linux VM running docker compose, inside a **private spoke VNet**. Nothing gets a public IP and every PaaS resource has public access disabled. Users reach the API through your App Gateway, and all egress goes through your Azure Firewall.

Use [`provider: azure`](../azure/guide.md) instead if you want the public Azure Functions deployment.

## What gets deployed (per environment)

```
 AVD / users ─► Azure Firewall ─► App Gateway (WAF) ─► VM :8080 ──┐   (hub: yours)
                                                                  │
 ┌──────────── Spoke VNet (this stack) ───────────────────────────▼──────────────┐
 │ snet-vm  VM (Ubuntu 24.04, docker compose)                                     │
 │            dp-api :8080 · dp-worker · dp-scheduler · mapping                   │
 │            UDR 0.0.0.0/0 → firewall · NSG: 8080 from App Gateway, 22 from admin│
 │ snet-pe  Private Endpoints: Blob · Key Vault · MongoDB Atlas                   │
 └────────────────────────────────────────────────────────────────────────────────┘
```

| Resource               | Notes                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| Resource group         | `<prefix>-<environment>-rg`                                                                               |
| Spoke VNet             | `snet-vm` (VM) and `snet-pe` (Private Endpoints); `defaultOutboundAccess: false`                          |
| Route table            | `0.0.0.0/0 → firewallPrivateIp`                                                                           |
| NSG                    | Inbound `8080` from `appGatewaySubnetCidr` and `22` from `adminSourceCidr`; all other VNet inbound denied |
| VM                     | No public IP, SSH key only, system-assigned identity, data disk mounted at `/var/lib/docker`              |
| Storage account        | Public access disabled, blob Private Endpoint, CORS limited to `allowedOrigins`                           |
| Key Vault              | RBAC, public access disabled, Private Endpoint; holds every secret the containers use                     |
| Atlas Private Endpoint | Azure side only (manual approval in Atlas)                                                                |

## How deploy and upgrade work

1. **First boot (cloud-init).** Formats the data disk and installs `docker.io`, `docker-compose-v2` and `jq` from the Ubuntu archive.
2. **Every `pulumi up` that changes something (Run Command `ingestro-deploy`).** The script:
   - writes `/opt/ingestro/docker-compose.yml`
   - reads secrets from Key Vault with the VM identity into `dp.env` and `mapping.env` (mode `0600`)
   - logs in to the registry
   - runs `docker compose pull && docker compose up -d`
   - waits until `dp-api` is healthy

   If `dp-api` doesn't become healthy, `pulumi up` fails.

3. **Upgrade.** Change `version` (and/or `mappingVersion`), then run `pulumi up`. The VM is not recreated.
4. **Rollback.** Set the previous `version`, then run `pulumi up`.

When you change a secret value through Pulumi config, the script runs again. If you change a secret directly in Key Vault, re-run it yourself with `pulumi up --replace <run-command-urn>`.

## Prerequisites

### On your side (hub)

- Azure Firewall with a private IP (the UDR next hop), and DNS proxy if you use it.
- Private DNS zones `privatelink.blob.core.windows.net` and `privatelink.vaultcore.azure.net`, linked to the spoke (or resolvable through your DNS proxy).
- VNet peering between hub and spoke. This stack does not create peering.
- An App Gateway listener + certificate for your hostname, e.g. `ingestro.company.local`.
- A MongoDB Atlas cluster (MongoDB ≥ 5.0) with Azure Private Link enabled.
- A DP license key per environment (Dev and Prod).

### Deployer machine

- Pulumi CLI, Node.js 18+, Azure CLI (`az login`).
- Outbound access to `api-gateway.ingestro.com`, used at deploy time to validate the license and get the registry key.
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

After the first `pulumi up`:

1. **Atlas:** approve the private endpoint and register `azureDocker.atlasPrivateEndpointId` / `atlasPrivateEndpointIp` (from `pulumi stack output azureDocker`) in Atlas.
2. **App Gateway:**
   - Backend pool `azureDocker.vmPrivateIp`, port `8080`, HTTP.
   - Health probe `GET /dp/api/v1/management/health` (expects 200).
3. **Embeddables:** set `baseUrl` to `https://<your-app-gateway-host>/dp`.

Repeat with a `<customer>-prod` stack and the prod license key.

## Firewall rules

**Inbound**

| From               | To                                | Port                                                     |
| ------------------ | --------------------------------- | -------------------------------------------------------- |
| AVD / user subnets | App Gateway                       | 443                                                      |
| App Gateway subnet | VM (`snet-vm`)                    | 8080                                                     |
| AVD / user subnets | Blob Private Endpoint (`snet-pe`) | 443 (the browser uploads and downloads through SAS URLs) |
| Admin / Bastion    | VM                                | 22                                                       |

**Egress allow-list (from `snet-vm`)**

| FQDN                                                                         | Why                                                   |
| ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| `api-gateway.ingestro.com`                                                   | License verification on every execution               |
| `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com` | Image pulls (not needed with ACR + Private Endpoint)  |
| `archive.ubuntu.com`, `security.ubuntu.com`, `azure.archive.ubuntu.com`      | cloud-init packages and security updates              |
| Azure OpenAI endpoint (or its Private Endpoint)                              | Mapping module LLM                                    |
| `*.pusher.com`, `*.pusherapp.com`                                            | Realtime updates, if enabled (also from AVD browsers) |
| `api.brevo.com`                                                              | Email notifications, if enabled                       |
| Your data sources / destinations                                             | Pipeline input and output connectors                  |

## Operations

```bash
ssh ingestro@<vm-private-ip>              # via Bastion / admin network
sudo docker compose -f /opt/ingestro/docker-compose.yml ps
sudo docker compose -f /opt/ingestro/docker-compose.yml logs -f dp-api dp-worker
df -h /var/lib/docker
```

- Container logs rotate at 5 × 50 MB per service.
- Run exactly one `dp-scheduler`, so that scheduled executions are not triggered twice.
- The VM is a single instance. Data lives in Atlas and Blob, so recovery means redeploying the stack.
