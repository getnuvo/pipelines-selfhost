<!-- markdownlint-disable -->
<p align="center">
  <a href="https://ingestro.com/" rel="noopener" target="_blank"><img width="150" src="https://s3.eu-central-1.amazonaws.com/general-upload.ingestro.com/ingestro_logo_darkblue.svg" alt="Ingestro logo"></a>
</p>
<h1 align="center">Ingestro Pipelines Self-host Azure Guide</h1>

# 🚀 Overview

Ingestro Pipelines can be self-hosted to give you full control over your data flow and infrastructure.

The deployment uses **Pulumi** for Infrastructure as Code (IaC) and **Azure** as the target cloud provider.

This document covers:

- Prerequisites
- Azure CLI installation and configuration
- Pulumi installation and initialization
- Repository setup
- Pulumi stack configuration
- Deployment and teardown commands
- Common troubleshooting and best practices

---

## Setting up Ingestro Pipelines Self-host Backend

### 1. Prerequisites

Before starting, ensure that you have the following:

- An **Azure account** with permissions to create/manage resources (Resource Groups, Storage Accounts, App Service, Networking, Cosmos DB).
- A **DP License Key** (available from your [Ingestro platform](https://dashboard.ingestro.com/dashboard)).
- A local machine with:
  - Node.js (v16+)
  - npm (v8+)
  - Azure CLI
  - Pulumi CLI (v3+)

---

### 2. Install and Configure the Azure CLI

Follow Microsoft’s official guide to install the Azure CLI:

👉 [Azure CLI Installation Guide](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli-macos?view=azure-cli-latest#install-with-homebrew)

Once installed, configure your Azure credentials:

```bash
az login
```

You will be redirected to the browser to connect your account:

To confirm your configuration:

```bash
az account show
```

If you have multiple subscriptions, set the one you want to deploy into:

```bash
az account set --subscription "<SUBSCRIPTION_ID_OR_NAME>"
```

---

### 3. Install and Configure Pulumi

Pulumi enables Infrastructure-as-Code (IaC) deployments.

Install it from the official documentation:

👉 [Pulumi Installation Guide](https://www.pulumi.com/docs/iac/download-install/#choose-an-operating-system)

Once installed, log in locally:

```bash
pulumi login --local
```

You should see output similar to:

```
Logged in to <your-machine>.local as <username> (file://~)
```

This confirms Pulumi is set up to store state locally (not in the Pulumi Cloud).

---

### 4. Clone and Initialize the Repository

Clone the Ingestro Pipelines Self-Host repository:

```bash
git clone https://github.com/getnuvo/pipelines-selfhost.git
```

Navigate to directory

```bash
cd pipelines-selfhost
```

Install dependencies:

```bash
npm install
```

---

### 5. Create and Configure a Pulumi Stack

Initialize a new Pulumi stack (run only once per environment):

```bash
pulumi stack init ingestro-pipelines
```

You’ll be prompted to create a passphrase to protect Pulumi secrets.

Store this passphrase securely — you’ll need it for future deployments or teardown commands.

After initialization, a file named `Pulumi.<stack-name>.yaml` is created in the repository root.

---

### 6. Edit Configuration

Open `Pulumi.<stack-name>.yaml` and update the following keys as needed.

> ⚠️ Important: This repository’s Pulumi project name is `pipeline-self-host`, so configuration keys must be under the `pipeline-self-host:` namespace (not `pipelines-self-host:`).

```yaml
encryptionsalt: <keep as is>
config:
  pipeline-self-host:provider: 'azure'
  pipeline-self-host:version: '0.54.7' # Check release notes for available versions
  pipeline-self-host:prefix: '<YOUR_ENVIRONMENT_TAG>' # Used for resource naming

  # Optional: Custom Domain (recommended for production)
  # pipeline-self-host:customDomain: 'dp.yourcompany.com'

  # Ingestro Settings
  pipeline-self-host:INGESTRO_LICENSE_KEY: '<YOUR_LICENSE_KEY>' # Required
  pipeline-self-host:S3_CONNECTOR_SECRET_KEY: '<RANDOM_LONG_SECRET>' # Required

  # Mapping Module (Azure deploys the mapping module as an App Service container)
  pipeline-self-host:MAPPING_CONTAINER_IMAGE: 'getnuvo/mapping:develop' # Required

  # ---- LLM CONFIGURATION ----
  pipeline-self-host:mappingLlmProvider: 'AZURE' # AZURE (Azure OpenAI) | BEDROCK (AWS Bedrock)
  pipeline-self-host:mappingLlmTemperature: 0.2

  # ---- Azure OpenAI Configuration ----
  pipeline-self-host:mappingAzureOpenaiApiKey: '<YOUR_API_KEY>'
  pipeline-self-host:mappingAzureOpenaiEndpoint: 'https://<your-resource>.openai.azure.com'
  pipeline-self-host:mappingAzureOpenaiApiVersion: '2024-10-21'
  pipeline-self-host:mappingAzureOpenaiDeploymentName: 'gpt-4o-mini' # Recommended for speed/quality balance

  # ---- AWS Bedrock Configuration ----
  pipeline-self-host:mappingAwsBedrockModelId: 'anthropic.claude-3-haiku-20240307-v1:0'
  pipeline-self-host:mappingAwsBedrockRegion: '<YOUR_MODEL_REGION>'
  pipeline-self-host:mappingAwsBedrockAccessKeyId: '<YOUR_MODEL_ACCESS_KEY>'
  pipeline-self-host:mappingAwsBedrockSecretAccessKey: '<YOUR_MODEL_SECRET_KEY>'
```

<aside>
💡 Tip: Use `pulumi config set --secret ...` for sensitive values (license keys, API keys, secret keys).
</aside>

---

### 7. Deploy the Stack

Once the configuration is complete, deploy the stack with:

```bash
pulumi up
```

Pulumi will preview the resources that will be created — review the plan and confirm with `y` to proceed.

<aside>

> 💡 After deploy, fetch your API endpoint with:
>
> ```bash
> pulumi stack output endpoint
> ```

</aside>

<asset>

> 💡 If you want to configure the Custom Domain, first follow our [Custom Domain Setup Guide](custom-domain-setup.md).

</asset>

---

### 8. Updating the Stack & Ingestro Version

<aside>
💡 You can always check the available versions in our release notes
</aside>

Fetch latest version of Ingestro’s selfhost configuration

```bash
git pull https://github.com/getnuvo/pipelines-selfhost.git
```

Update the ingestro version in your pulumi config

```bash
encryptionsalt: XXXX
config:
  ...
  pipeline-self-host:version: 'XXX' ## Change this
  ...
```

Re-deploy:

```bash
pulumi up
```

Pulumi will automatically detect differences and apply incremental updates.

---

### 9. Destroy the Stack

To completely remove all deployed infrastructure:

```bash
pulumi destroy
```

You’ll be prompted to confirm. This will decommission all Azure resources created by the stack.

---

### 10. Troubleshooting and Tips

| Issue                               | Possible Cause                       | Solution                                            |
| ----------------------------------- | ------------------------------------ | --------------------------------------------------- |
| **Authentication failure**          | Azure credentials not set or expired | Run `az login` again                                |
| **Missing password/keys in config** | Empty placeholders in YAML           | Double-check all secrets before running `pulumi up` |

---

## Setting up Ingestro Pipelines Frontend Embeddables

All Ingestro frontend [embeddables](https://docs.ingestro.com/dp/embeddables/) are compatible with the **self-hosted backend**.

You can define the API endpoint used by your embeddables through the `baseUrl` setting.

**`baseUrl`** — specifies the endpoint where all API calls are made.

- If no `baseUrl` is provided, all calls are sent to the **Ingestro Cloud Backend**.
- If you provide the **self-hosted backend URL**, all calls will be routed to **your own backend** instead.

Example

```jsx
<CreatePipeline
  settings={{
    baseUrl: "https://www.dummy.com",
    ... other settings
  }}
  ... other props
/>
```

<aside>

> 💡 Use the value from `pulumi stack output endpoint` as your `baseUrl`.

</aside>

---

# 🧭 Best Practices

- Store Pulumi stack state securely.
- Rotate credentials and update them in Pulumi config regularly.
- Maintain version control for `Pulumi.yaml` to track infrastructure changes.
- Always run `pulumi preview` before applying changes.

---

# 📚 References

- [Azure CLI Documentation](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli-macos?view=azure-cli-latest#install-with-homebrew)
- [Pulumi CLI Documentation](https://www.pulumi.com/docs/iac/download-install/#choose-an-operating-system)
- [Pulumi Azure Provider](https://www.pulumi.com/registry/packages/azure-native/)
- [Ingestro Pipelines Documentation](https://docs.ingestro.com/dp/start)

---
