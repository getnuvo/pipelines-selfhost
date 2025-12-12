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

- An **AWS account** with permissions to manage EC2, S3, and DocumentDB.
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

After initialization, a file named `Pulumi.ingestro-pipelines.yaml` is created in the repository root.

---

### 6. Edit Configuration

Open `Pulumi.ingestro-pipelines.yaml` and update the following keys as needed:

```yaml
encryptionsalt: <keep as is>
config:
  aws:region: 'eu-central-1' # Must match your AWS profile region
  aws:profile: 'ingestro-pipelines' # Comment out if using the default AWS profile
  pipelines-self-host:provider: 'aws'
  pipelines-self-host:version: '0.29.4' # Check release notes for available versions
  pipelines-self-host:prefix: '<YOUR_ENVIRENMENT_TAG>'

  # Ingestro Settings
  pipelines-self-host:INGESTRO_LICENSE_KEY: '<YOUR_LICENSE_KEY>'
  pipelines-self-host:DATA_PIPELINE_DB_NAME: 'ingestro'
  pipelines-self-host:S3_CONNECTOR_SECRET_KEY: 'vbeDWPY67Ip7JfcVdbDi2Yg4BcLAbgTz4af87040XVIjF1FiFp'

  # AWS S3 Configuration
  pipelines-self-host:AWS_REGION: 'eu-central-1'
  pipelines-self-host:AWS_ACCESS_KEY: '<YOUR_AWS_ACCESS_KEY>'
  pipelines-self-host:AWS_SECRET_KEY: '<YOUR_AWS_SECRET_KEY>'

  # Document DB Setup
  pipelines-self-host:docdbUsername: 'master_ingestro'
  pipelines-self-host:docdbPassword: '<SET_A_SECURE_PASSWORD>'

  # Mapping Module Settings
  pipelines-self-host:dockerImageName: 'getnuvo/mapping:develop'
  pipelines-self-host:dockerHubUsername: 'getnuvo'
  pipelines-self-host:ec2InstanceType: 't3.large'
  pipelines-self-host:rootVolumeSize: 30

  # ---- LLM CONFIGURATION ----
  pipelines-self-host:mappingLlmProvider: 'AZURE' # **NOTE:** You can select between AZURE for using an GPT model via Azure OpenAI or BEDROCK for using a Claude model via AWS Bedrock
  pipelines-self-host:mappingLlmTemperature: 0.2

  # ---- Azure OpenAI Configuration ----
  pipelines-self-host:mappingAzureOpenaiApiKey: '<YOUR_API_KEY>'
  pipelines-self-host:mappingAzureOpenaiEndpoint: '<YOUR_API_ENDPOINT>'
  pipelines-self-host:mappingAzureOpenaiApiVersion: '<YOUR_API_VERSION>'
  pipelines-self-host:mappingAzureOpenaiDeploymentName: 'gpt-4o-mini' # **NOTE:** To guarantee the best balance between mapping accuracy and processing speed, we recommend using the GPT 4o mini model

  # ---- AWS Bedrock Configuration ----
  pipelines-self-host:mappingAwsBedrockModelId: '<YOUR_MODEL_ID>' # **NOTE:** To guarantee the best balance between mapping accuracy and processing speed, we recommend using the Claude Haiku 3 model via anthropic.claude-3-haiku-20240307-v1:0
  pipelines-self-host:mappingAwsBedrockRegion: '<YOUR_MODEL_REGION>'
  pipelines-self-host:mappingAwsBedrockAccessKeyId: '<YOUR_MODEL_ACCESS_KEY>'
  pipelines-self-host:mappingAwsBedrockSecretAccessKey: '<YOUR_MODEL_SECRET_KEY>'
```

<aside>
💡 A reference template is available in Pulumi.yaml.example. You can copy values from there and adjust for your environment.
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
💡 Check our guide to see how you can configure your embeddables to use this endpoint: here
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

All **Ingestro frontend embeddables** are compatible with the **self-hosted backend**.

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
💡 Make sure to replace the URL with the endpoint you received after deploying your self-hosted backend.
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
