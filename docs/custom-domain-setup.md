# Custom Domain Configuration for API Gateway

This guide explains how to configure your API Gateway to use a custom domain with Cloudflare.

## Prerequisites

1. A domain name managed by Cloudflare
2. AWS account with appropriate permissions
3. Access to Cloudflare DNS management

## Setup Steps

### Initial Certificate (skip this if you already have it)

1. **Run command and do follow command suggestion:**
   ```bash
   ./scripts/create-certificate.sh -d {domain} -r {region}
   ```
   eg. ./scripts/create-certificate.sh -d selfhosted-test.ingestro.com -r eu-central-1
