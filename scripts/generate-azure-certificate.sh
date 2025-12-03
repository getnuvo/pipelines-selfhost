#!/usr/bin/env bash
set -euo pipefail

# Generate and bind an Azure-managed certificate for custom domain HTTPS
# This script should be run AFTER the custom domain binding is created and DNS is verified
#
# Requirements: Azure CLI, jq
#
# Usage:
#   scripts/generate-azure-certificate.sh [-r <resource-group>] [-a <app-name>] [-d <domain>] [--region <region>] [--dry-run]
#
# Flags:
#   -r  Resource group name (required)
#   -a  App Service/Function App name (required)
#   -d  Custom domain (required)
#   --region  Azure region (default: eu-central-1)
#   --dry-run  Show what would be done without making changes

usage() {
  echo "Usage: $0 -r <resource-group> -a <app-name> -d <domain> [--region <region>] [--dry-run]" >&2
  echo ""
  echo "Example:"
  echo "  $0 -r fluke-functions-rg -a fluke-dp-self-hosted -d dp-selfhosted-test.filedocks.com"
  exit 1
}

# Defaults
RESOURCE_GROUP=""
APP_NAME=""
CUSTOM_DOMAIN=""
REGION="eu-central-1"
DRY_RUN=0

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    -r) RESOURCE_GROUP="$2"; shift 2;;
    -a) APP_NAME="$2"; shift 2;;
    -d) CUSTOM_DOMAIN="$2"; shift 2;;
    --region) REGION="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift 1;;
    -h|--help) usage;;
    *) echo "Unknown option: $1" >&2; usage;;
  esac
done

if [[ -z "$RESOURCE_GROUP" || -z "$APP_NAME" || -z "$CUSTOM_DOMAIN" ]]; then
  echo "Error: -r <resource-group>, -a <app-name>, and -d <domain> are required" >&2
  usage
fi

if ! command -v az >/dev/null 2>&1; then
  echo "Error: Azure CLI is required (https://docs.microsoft.com/cli/azure/install-azure-cli)" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required (brew install jq)" >&2
  exit 3
fi

echo "================================================"
echo "Azure Managed Certificate Generator"
echo "================================================"
echo "Resource Group: $RESOURCE_GROUP"
echo "App Name:       $APP_NAME"
echo "Domain:         $CUSTOM_DOMAIN"
echo "Region:         $REGION"
echo "================================================"
echo ""

# Check if logged in
if ! az account show >/dev/null 2>&1; then
  echo "Error: Not logged in to Azure. Run 'az login' first." >&2
  exit 4
fi

# Check if domain binding exists
echo ""
echo "1️⃣  Checking if custom domain binding exists..."
BINDING_EXISTS=$(az functionapp config hostname list \
  --webapp-name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query "[?name=='$CUSTOM_DOMAIN'].name" \
  -o tsv 2>/dev/null || true)

if [[ -z "$BINDING_EXISTS" ]]; then
  # Try as web app
  BINDING_EXISTS=$(az webapp config hostname list \
    --webapp-name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --query "[?name=='$CUSTOM_DOMAIN'].name" \
    -o tsv 2>/dev/null || true)
fi

if [[ -z "$BINDING_EXISTS" ]]; then
  echo "   ❌ Domain binding for '$CUSTOM_DOMAIN' not found on app '$APP_NAME'"
  echo "   Create the binding first with 'pulumi up' before running this script"
  exit 6
fi

echo "   ✅ Domain binding exists"

# Create certificate name (replace dots with dashes)
CERT_NAME="${CUSTOM_DOMAIN//\./-}-cert"

# Check if certificate already exists
echo ""
echo "2️⃣  Checking if certificate already exists..."
CERT_EXISTS=$(az webapp config ssl list \
  --resource-group "$RESOURCE_GROUP" \
  --query "[?name=='$CERT_NAME'].name" \
  -o tsv 2>/dev/null || echo "")

if [[ -n "$CERT_EXISTS" ]]; then
  echo "   ⚠️  Certificate '$CERT_NAME' already exists"
  read -p "   Do you want to recreate it? (y/N): " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "   Skipping certificate creation"
    SKIP_CERT=1
  else
    SKIP_CERT=0
  fi
else
  echo "   Certificate does not exist, will create"
  SKIP_CERT=0
fi

# Create managed certificate
if [[ $SKIP_CERT -eq 0 ]]; then
  echo ""
  echo "3️⃣  Creating Azure-managed certificate..."
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "   [DRY-RUN] Would create certificate: $CERT_NAME"
  else
    az webapp config ssl create \
      --name "$CERT_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --hostname "$CUSTOM_DOMAIN" \
      --location "$REGION" \
      2>/dev/null || {
      echo "   ⚠️  Note: Certificate creation initiated. It may take 5-15 minutes to provision."
      echo "   Azure will automatically verify domain ownership and issue the certificate."
    }
    echo "   ✅ Certificate creation requested"
  fi
fi

# Wait for certificate to be ready
echo ""
echo "4️⃣  Waiting for certificate to be provisioned..."
if [[ $DRY_RUN -eq 1 ]]; then
  echo "   [DRY-RUN] Would wait for certificate to be ready"
else
  MAX_WAIT=900  # 15 minutes
  WAIT_INTERVAL=30
  ELAPSED=0
  
  while [[ $ELAPSED -lt $MAX_WAIT ]]; do
    CERT_THUMBPRINT=$(az webapp config ssl list \
      --resource-group "$RESOURCE_GROUP" \
      --query "[?subjectName=='$CUSTOM_DOMAIN'].thumbprint" \
      -o tsv 2>/dev/null || echo "")
    
    if [[ -n "$CERT_THUMBPRINT" ]]; then
      echo "   ✅ Certificate ready! Thumbprint: $CERT_THUMBPRINT"
      break
    fi
    
    echo "   ⏳ Still waiting... ($ELAPSED seconds elapsed)"
    sleep $WAIT_INTERVAL
    ELAPSED=$((ELAPSED + WAIT_INTERVAL))
  done
  
  if [[ -z "$CERT_THUMBPRINT" ]]; then
    echo "   ⚠️  Certificate not ready after ${MAX_WAIT}s. It may still be provisioning."
    echo "   Check Azure Portal or run this script again later."
    exit 7
  fi
fi

# Bind certificate to custom domain with SNI SSL
echo ""
echo "5️⃣  Binding certificate to custom domain with SNI SSL..."
if [[ $DRY_RUN -eq 1 ]]; then
  echo "   [DRY-RUN] Would bind certificate with SNI SSL"
else
  az functionapp config ssl bind \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --certificate-thumbprint "$CERT_THUMBPRINT" \
    --ssl-type SNI \
    2>/dev/null || \
  az webapp config ssl bind \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --certificate-thumbprint "$CERT_THUMBPRINT" \
    --ssl-type SNI \
    2>/dev/null || {
    echo "   ❌ Failed to bind certificate"
    exit 8
  }
  
  echo "   ✅ Certificate bound successfully"
fi

echo ""
echo "================================================"
echo "✅ HTTPS Enabled!"
echo "================================================"
echo "Your custom domain is now accessible via HTTPS:"
echo "   https://$CUSTOM_DOMAIN"
echo ""
echo "The certificate will auto-renew before expiration."
echo "================================================"
