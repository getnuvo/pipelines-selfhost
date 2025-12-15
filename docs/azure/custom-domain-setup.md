# 🌐 Custom Domain Setup Guide

This guide walks you through configuring a **custom domain** for your self-hosted Ingestro Pipelines Azure deployment.

It covers post-deployment DNS configuration.

<aside>

> ⚠️ Important: Complete this guide **after** running `pulumi up` if you want to use a custom domain.

</aside>

---

## 1. Deploy Your Infrastructure

Once you have followed the main guide [**Ingestro Pipelines – Self-Host Deployment Guide**](https://www.notion.so/Ingestro-Pipelines-Self-Host-Deployment-Guide-28e3b22be90380b68170f207d2f8483a?pvs=21)

```bash
pulumi up
```

After deployment, Pulumi will output the **DNS records** you must add to your DNS.

It will look like:

```bash
    ================================================================================
    🌐 CUSTOM DOMAIN SETUP REQUIRED
    ================================================================================
    ⚠️  IMPORTANT: Create these DNS records BEFORE the binding is applied:
    📋 Domain: ******
    🔗 Target: ******
    Required DNS Records:
    --------------------------------------------------------------------------------
    1️⃣  TXT Record (Domain Verification - REQUIRED FIRST)
       Name:  X****
       Value: X****
       TTL:   3600
    2️⃣  CNAME Record (Domain Mapping)
       Name:  X****
       Value: X****
       TTL:   3600
    --------------------------------------------------------------------------------
    ✅ Action Required:
       1. Go to your DNS provider (e.g., Cloudflare, Route53)
       2. Add the DNS records listed above
       3. Wait 5-10 minutes for DNS propagation
       4. Run `pulumi up` again to create the binding
    ================================================================================
```

---

## 2. Add DNS records

Go to your DNS provider and add:

TXT RECORD

- **Name:** (copy the TXT **Name** from Pulumi output; often `asuid.<your-domain>` but do not assume)
- **Type:** TXT
- **Value:** Shown in the Pulumi output
- **TTL:** 3600 (or your preference)
- **Proxy:** DNS Only

CNAME

- **Name:** your custom domain (e.g., `selfhost.acme.com`)
- **Type:** CNAME
- **Value:** use the Target hostname from Pulumi output
- **TTL:** 3600 (or your preference)
- **Proxy:** DNS Only

Once DNS propagates (5–30 min), your API will be reachable via your domain.

<aside>

> ⚠️ If using Cloudflare, ensure Proxy = DNS Only
>
> API Gateway does not work through Cloudflare's orange-cloud proxy.

</aside>

---

## 3. Test Your Custom Domain

Test the health endpoint:

```bash
curl "https://<your-domain>/dp/api/v1/management/health"
```

You can also test using the **Azure Function URL** printed during `pulumi up`.

If you see a `200 OK` with a JSON response, everything is correctly configured.

---

## 🎉 You're Done

Your custom domain is now fully configured and integrated with the self-hosted Ingestro Pipelines backend.
