<!-- markdownlint-disable -->
<p align="center">
  <a href="https://ingestro.com/" rel="noopener" target="_blank"><img width="150" src="https://s3.eu-central-1.amazonaws.com/general-upload.ingestro.com/ingestro_logo_darkblue.svg" alt="Ingestro logo"></a>
</p>
<h1 align="center">Ingestro Pipelines Self-host AWS Guide</h1>

# 🚀 Overview

Ingestro Pipelines can be self-hosted to give you full control over your data flow and infrastructure.

The deployment uses **Pulumi** for Infrastructure as Code (IaC) and **AWS** as the target cloud provider.

This document covers:

- Prerequisites
- AWS CLI installation and configuration
- Pulumi installation and initialization
- Repository setup
- Pulumi stack configuration
- Deployment and teardown commands
- Common troubleshooting and best practices

---

## Setting up Ingestro Pipelines Self-host Backend

### 1. Prerequisites

Before starting, ensure that you have the following:

- An **AWS account** with permissions to manage Lambda, API Gateway, IAM, VPC, EFS, EC2, S3, and DocumentDB.
- A **DP License Key** (available from your [Ingestro platform](https://dashboard.ingestro.com/dashboard)).
- A local machine with:
  - Node.js (v16+)
  - npm (v8+)
  - AWS CLI (v2)
  - Pulumi CLI (v3+)

---

### 2. Install and Configure the AWS CLI

Follow AWS’s official guide to install the CLI:

👉 [AWS CLI Installation Guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)

Once installed, configure your AWS credentials:

```bash
aws configure
```

You will be prompted for:

- **AWS Access Key ID**
- **AWS Secret Access Key**
- **Default region name** (e.g., `eu-central-1`)
- **Output format** (default: `json`)

To confirm your configuration:

```bash
aws configure list-profiles
```

We **recommend creating a dedicated profile** for the deployment:

```bash
aws configure --profile ingestro-pipelines
```

<aside>
⚠️ Note: The Pulumi configuration must reference the same region as your AWS CLI profile. Using a consistent region avoids mismatched deployments and stack errors.
</aside>

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
  aws:region: 'eu-central-1' # Must match your AWS profile region
  aws:profile: 'ingestro-pipelines' # Comment out if using the default AWS profile
  pipeline-self-host:provider: 'aws'
  pipeline-self-host:version: '0.54.7' # Check release notes for available versions
  pipeline-self-host:prefix: '<YOUR_ENVIRONMENT_TAG>' # Used for resource naming

  # Optional: Custom Domain (recommended for production)
  # pipeline-self-host:customDomain: 'dp.yourcompany.com'
  # pipeline-self-host:certificateArn: 'arn:aws:acm:...'

  # Ingestro Settings
  pipeline-self-host:INGESTRO_LICENSE_KEY: '<YOUR_LICENSE_KEY>' # Required
  pipeline-self-host:DATA_PIPELINE_DB_NAME: 'ingestro' # Required
  pipeline-self-host:S3_CONNECTOR_SECRET_KEY: '<RANDOM_LONG_SECRET>' # Required

  # AWS S3 Configuration
  pipeline-self-host:AWS_REGION: 'eu-central-1' # Required
  pipeline-self-host:AWS_ACCESS_KEY: '<YOUR_AWS_ACCESS_KEY>' # Required
  pipeline-self-host:AWS_SECRET_KEY: '<YOUR_AWS_SECRET_KEY>' # Required

  # Document DB Setup
  pipeline-self-host:docdbUsername: 'master' # Optional (default: master)
  pipeline-self-host:docdbPassword: '<SET_A_SECURE_PASSWORD>' # Required

  # Mapping Module Settings
  pipeline-self-host:dockerImageName: 'getnuvo/mapping:develop'
  pipeline-self-host:dockerHubUsername: 'getnuvo'
  pipeline-self-host:ec2InstanceType: 't3.large'
  pipeline-self-host:rootVolumeSize: 30

  # ---- LLM CONFIGURATION ----
  pipeline-self-host:mappingLlmProvider: 'AZURE' # AZURE (Azure OpenAI) | BEDROCK (AWS Bedrock)
  pipeline-self-host:mappingLlmTemperature: 0.2

  # ---- Azure OpenAI Configuration ----
  pipeline-self-host:mappingAzureOpenaiApiKey: '<YOUR_API_KEY>'
  pipeline-self-host:mappingAzureOpenaiEndpoint: 'https://<your-resource>.openai.azure.com'
  pipeline-self-host:mappingAzureOpenaiApiVersion: '2024-10-21'
  pipeline-self-host:mappingAzureOpenaiDeploymentName: 'gpt-4o-mini'

  # ---- AWS Bedrock Configuration ----
  pipeline-self-host:mappingAwsBedrockModelId: '<YOUR_MODEL_ID>'
  pipeline-self-host:mappingAwsBedrockRegion: '<YOUR_MODEL_REGION>'
  pipeline-self-host:mappingAwsBedrockAccessKeyId: '<YOUR_MODEL_ACCESS_KEY>'
  pipeline-self-host:mappingAwsBedrockSecretAccessKey: '<YOUR_MODEL_SECRET_KEY>'
```

<aside>
💡 Tip: Use `pulumi config set --secret ...` for sensitive values (license keys, API keys, secret keys, db passwords).
</aside>

---

### 7. Deploy the Stack

<asset>

> 💡 If you want to configure the Custom Domain, first follow our [Custom Domain Setup Guide](custom-domain-setup.md).

</asset>

Once the configuration is complete, deploy the stack with:

```bash
pulumi up
```

Pulumi will preview the resources that will be created — review the plan and confirm with `y` to proceed.

Deployment typically includes:

- S3 bucket provisioning
- DocumentDB setup
- EC2 instance creation for mapping
- Networking and IAM configuration

<aside>
> 💡 After deploy, fetch your API endpoint with:
>
> ```bash
> pulumi stack output endpoint
> ```
</aside>

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

You’ll be prompted to confirm. This will decommission all AWS resources created by the stack.

---

### 10. Troubleshooting and Tips

| Issue                                    | Possible Cause                            | Solution                                                        |
| ---------------------------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| **Pulumi error: missing region/profile** | AWS CLI region not matching Pulumi config | Ensure both have the same `eu-central-1` region                 |
| **Authentication failure**               | AWS credentials not set or expired        | Run `aws configure` again                                       |
| **“Access Denied” in Pulumi**            | IAM permissions insufficient              | Use a user with `AdministratorAccess` during initial deployment |
| **Deployment timeout**                   | Networking or VPC misconfiguration        | Verify security group and VPC settings in AWS console           |
| **Missing password/keys in config**      | Empty placeholders in YAML                | Double-check all secrets before running `pulumi up`             |

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

- Use **dedicated AWS profiles** for staging/production.
- Store Pulumi stack state securely (consider S3 backend for team usage).
- Rotate credentials and update them in Pulumi config regularly.
- Maintain version control for `Pulumi.yaml` to track infrastructure changes.
- Always run `pulumi preview` before applying changes.

---

# 📚 References

- [AWS CLI Documentation](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- [Pulumi CLI Documentation](https://www.pulumi.com/docs/iac/download-install/#choose-an-operating-system)
- [Pulumi AWS Provider](https://www.pulumi.com/registry/packages/aws/)
- [Ingestro Pipelines Documentation](https://docs.ingestro.com/dp/start)

---
