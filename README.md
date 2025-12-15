<!-- markdownlint-disable -->
<p align="center">
  <a href="https://ingestro.com/" rel="noopener" target="_blank"><img width="150" src="https://s3.eu-central-1.amazonaws.com/general-upload.ingestro.com/ingestro_logo_darkblue.svg" alt="Ingestro logo"></a>
</p>
<h1 align="center">Ingestro Pipelines Self-host Guide</h1>

# 🚀 Overview

Ingestro Pipelines can be self-hosted to give you full control over your data flow and infrastructure.

This repository uses **Pulumi** (Infrastructure as Code) and supports deploying to:

- **AWS**
- **Azure**

Use this `README.md` as the starting point, then follow the provider-specific guide for step-by-step deployment.

---

## 🧭 Choose your cloud provider

- **AWS deployment guide**: [AWS Guide](./docs/Aws/Guide.md)
- **Azure deployment guide**: [Azure Guide](./docs/Azure/Guide.md)

If you plan to use a custom domain, start here:

- **AWS custom domain setup**: [AWS Guide](./docs/Aws/custom-domain-setup.md)
- **Azure custom domain setup**: [Azure Guide](./docs/Azure/custom-domain-setup.md)

---

## ✅ What you get (high level)

The self-host deployment provisions the backend infrastructure needed to run Ingestro Pipelines in your cloud account.

Provider-specific details differ, but you should expect:

- A deployed **API endpoint** for the Pipelines backend
- Supporting infrastructure (networking, storage, database, observability)
- Optional **custom domain** support

---

## 🧰 Prerequisites (common)

Before starting, ensure you have:

- A **DP License Key** (available from your [Ingestro platform](https://dashboard.ingestro.com/dashboard))
- Node.js + npm
- Pulumi CLI (v3+)
- The cloud CLI for your target provider:
  - AWS: AWS CLI
  - Azure: Azure CLI

Follow the relevant guide for exact versions, permissions, and authentication steps:

- `docs/Aws/Guide.md`
- `docs/Azure/Guide.md`

---

## 🚀 Deploy / Update / Destroy

All provider guides follow the same core flow:

- **Deploy**: `pulumi up`
- **Update**: edit stack config + `pulumi up`
- **Destroy**: `pulumi destroy`

---

## 🔎 Getting the deployed API endpoint

After deployment, your backend URL is exposed as a Pulumi stack output.

From the repo root:

```bash
pulumi stack output endpoint
```

---

## 🧩 Using the self-hosted backend with Ingestro embeddables

All **Ingestro frontend embeddables** are compatible with the **self-hosted backend**.

Set `baseUrl` to the endpoint you deployed (see `pulumi stack output endpoint` above).

Example:

```jsx
<CreatePipeline
  settings={{
    baseUrl: "https://www.dummy.com",
    ... other settings
  }}
  ... other props
/>
```

---

# 🧭 Best Practices

- Use **separate stacks** (e.g. staging/production) and keep secrets out of source control.
- Store Pulumi state securely (especially for team usage).
- Rotate credentials and update them in Pulumi config regularly.
- Maintain version control for `Pulumi.yaml` to track infrastructure changes.
- Always run `pulumi preview` before applying changes.

---

# 📚 References

- [AWS Guide](docs/Aws/Guide.md)
- [Azure Guide](docs/Azure/Guide.md)
- [Pulumi CLI Documentation](https://www.pulumi.com/docs/iac/download-install/#choose-an-operating-system)
- [Pulumi AWS Provider](https://www.pulumi.com/registry/packages/aws/)
- [Pulumi Azure Provider](https://www.pulumi.com/registry/packages/azure-native/)
- [Ingestro Pipelines Documentation](https://docs.ingestro.com/dp/start)

---
