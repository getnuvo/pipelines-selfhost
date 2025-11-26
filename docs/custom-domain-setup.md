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

## Uninstall by using pulumi

** this option will destroy the whole infla you have setup via pulumi please carefully

1. `Pulumi destroy`
2. wait till all has been destroy
3. remove the [Certificate](https://eu-central-1.console.aws.amazon.com/acm/home?region=eu-central-1#/certificates/list)
4. remove the dns records from cloud provider

## Uninstall by aws console

1. remove [Custom domain](https://eu-central-1.console.aws.amazon.com/apigateway/main/publish/domain-names?api=unselected&region=eu-central-1#)
2. remove [Certificate](https://eu-central-1.console.aws.amazon.com/acm/home?region=eu-central-1#/certificates/list)
3. remove the dns records from cloud provider 
4. type command `pulumi refresh` to make it sync with current pulumi cache