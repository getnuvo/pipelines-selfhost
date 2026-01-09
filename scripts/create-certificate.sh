#!/usr/bin/env bash
set -euo pipefail

# Create an ACM certificate for API Gateway custom domain with DNS validation
# This script creates certificates compatible with API Gateway REGIONAL endpoints
#
# Requirements: bash, aws-cli, jq
#
# Usage:
#   scripts/create-certificate.sh -d example.com [-p function-prefix] [-r region] [-w] [-W] [-v] [-h]
#
# Flags:
#   -d  Domain name (required) - e.g., api.example.com
#   -p  Function prefix for naming (default: pipelines)
#   -r  AWS region (REQUIRED for API Gateway - must match your API Gateway region)
#   -w  Include wildcard subdomain (*.domain.com) as SAN
#   -W  Wait for certificate validation (after DNS records are added)
#   -v  Verbose output
#   -h  Help
#
# Notes:
# - Certificate is created for API Gateway REGIONAL endpoints (not CloudFront)
# - MUST be in the same AWS region as your API Gateway
# - Uses DNS validation (required for API Gateway)
# - Outputs DNS validation records for manual addition to DNS provider
# - Use -W flag to automatically wait for validation after adding DNS records

usage() {
  echo "Usage: $0 -d <domain> [-p <prefix>] -r <region> [-w] [-W] [-v]" >&2
  echo "" >&2
  echo "Examples:" >&2
  echo "  $0 -d api.example.com -r eu-central-1" >&2
  echo "  $0 -d api.example.com -p myapi -r us-west-2 -w" >&2
  echo "  $0 -d api.example.com -r eu-west-1 -W" >&2
  echo "" >&2
  echo "Important:" >&2
  echo "  - Region (-r) is REQUIRED and must match your API Gateway region" >&2
  echo "  - For API Gateway, certificate must be in same region as the API" >&2
  echo "  - Use -w to include wildcard (*.domain.com) as Subject Alternative Name" >&2
  echo "  - Use -W to wait for validation after adding DNS records" >&2
  exit 1
}

setup_custom_domain() {
  echo "========================================="
  echo "🎉 Custom Domain Setup Instructions"
  echo "========================================="
  echo ""
  echo "📋 Step 1: Configure Pulumi with your certificate and domain"
  echo "   Run these commands:"
  echo ""
  echo "   pulumi config set certificateArn '$CERT_ARN'"
  echo "   pulumi config set customDomain '$DOMAIN'"
  echo ""
  echo "📋 Step 2: Deploy your infrastructure"
  echo "   pulumi up"
  echo ""
  echo "📋 Step 3: After deployment, add DNS CNAME record"
  echo "   The 'pulumi up' output will show you the CNAME record details."
  echo "   It will look something like:"
  echo ""
  echo "   🌐 Add this CNAME record to your DNS provider:"
  echo "      Name:  $DOMAIN"
  echo "      Type:  CNAME"
  echo "      Value: <regional-domain-name>.execute-api.$REGION.amazonaws.com"
  echo "      TTL:   300 (or your preferred value)"
  echo ""
  echo "   ⚠️  Important DNS settings:"
  echo "      - If using Cloudflare: Set Proxy to 'DNS only' (grey cloud)"
  echo "      - If using other providers: Just add as a standard CNAME record"
  echo ""
  echo "📋 Step 4: Test your custom domain"
  echo "   After DNS propagation (5-30 minutes), test your API:"
  echo ""
  echo "   curl https://$DOMAIN/health"
  echo ""
  echo "========================================="
  echo "✅ Certificate is ready and validated!"
  echo "   ARN: $CERT_ARN"
  echo "========================================="
  echo ""
}

DOMAIN=""
PREFIX="pipelines"
REGION=""
INCLUDE_WILDCARD=0
WAIT_FOR_VALIDATION=0
VERBOSE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d) DOMAIN="$2"; shift 2;;
    -p) PREFIX="$2"; shift 2;;
    -r) REGION="$2"; shift 2;;
    -w) INCLUDE_WILDCARD=1; shift 1;;
    -W) WAIT_FOR_VALIDATION=1; shift 1;;
    -v) VERBOSE=1; shift 1;;
    -h|--help) usage;;
    *) echo "Unknown option: $1" >&2; usage;;
  esac
done

if [[ -z "$DOMAIN" ]]; then
  echo "Error: Domain name is required (-d)" >&2
  usage
fi

if [[ -z "$REGION" ]]; then
  echo "Error: AWS region is REQUIRED (-r) for API Gateway certificates" >&2
  echo "The certificate must be in the same region as your API Gateway" >&2
  usage
fi

# Check required tools
if ! command -v aws >/dev/null 2>&1; then
  echo "Error: 'aws' CLI not found. Please install AWS CLI." >&2
  exit 3
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: 'jq' not found. Please install jq for JSON parsing." >&2
  exit 3
fi

# Check AWS credentials
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "Error: AWS credentials not configured. Run 'aws configure' first." >&2
  exit 4
fi

# Validate that the region is correct for API Gateway
echo "🔐 Creating ACM certificate for API Gateway custom domain: $DOMAIN"
echo "   Region: $REGION (must match your API Gateway region)"
echo "   Prefix: $PREFIX"
if [[ $INCLUDE_WILDCARD -eq 1 ]]; then
  echo "   Including wildcard: *.${DOMAIN}"
fi
echo ""

# Build domain list for certificate
DOMAIN_ARGS="--domain-name $DOMAIN"
if [[ $INCLUDE_WILDCARD -eq 1 ]]; then
  DOMAIN_ARGS="$DOMAIN_ARGS --subject-alternative-names *.${DOMAIN}"
fi

# Create certificate request (compatible with API Gateway REGIONAL endpoints)
CERT_ARN=$(aws acm request-certificate \
  $DOMAIN_ARGS \
  --validation-method DNS \
  --region "$REGION" \
  --tags Key=Name,Value="$PREFIX-api-gateway-certificate" \
         Key=Application,Value="pipelines-selfhost" \
         Key=Purpose,Value="API Gateway REGIONAL endpoint" \
         Key=Domain,Value="$DOMAIN" \
  --query 'CertificateArn' \
  --output text)

if [[ $VERBOSE -eq 1 ]]; then
  echo "Certificate ARN: $CERT_ARN"
fi

echo "✅ Certificate request submitted successfully!"
echo ""

# Wait a moment for AWS to populate validation options
echo "⏳ Waiting for DNS validation records..."
sleep 5

# Get DNS validation records
VALIDATION_RECORDS=$(aws acm describe-certificate \
  --certificate-arn "$CERT_ARN" \
  --region "$REGION" \
  --query 'Certificate.DomainValidationOptions' \
  --output json)

echo "🔐 DNS Validation Records (Add these to your DNS provider):"
echo "================================================================"

# Parse and display validation records
echo "$VALIDATION_RECORDS" | jq -r '.[] | 
  "Domain: " + .DomainName + "\n" +
  "Record Name: " + .ResourceRecord.Name + "\n" +
  "Record Type: " + .ResourceRecord.Type + "\n" +
  "Record Value: " + .ResourceRecord.Value + "\n" +
  "----------------------------------------"'

echo ""
echo "⚠️  IMPORTANT: Add the above DNS records to your DNS provider before proceeding."
echo ""
echo "📋 Certificate Details:"
echo "   ARN: $CERT_ARN"
echo "   Status: PENDING_VALIDATION"
echo "   Compatible with: API Gateway REGIONAL endpoints"
echo ""

# Save certificate ARN to file for later use
CERT_FILE="./temp/certificate-arn.txt"
mkdir -p "$(dirname "$CERT_FILE")"
echo "$CERT_ARN" > "$CERT_FILE"

echo "💾 Certificate ARN saved to: $CERT_FILE"
echo ""

if [[ $WAIT_FOR_VALIDATION -eq 1 ]]; then
  echo "⏳ Waiting for certificate validation..."
  echo "   This will wait until DNS records are added and validated"
  echo "   You can press Ctrl+C to cancel waiting"
  echo ""
  
  if aws acm wait certificate-validated --certificate-arn "$CERT_ARN" --region "$REGION"; then
    echo "✅ Certificate validated successfully!"
    echo ""
    setup_custom_domain
  else
    echo "❌ Certificate validation failed or timed out"
    echo "   Check DNS records and try again"
    exit 6
  fi
else
  echo "🔍 To check validation status:"
  echo "   aws acm describe-certificate --certificate-arn '$CERT_ARN' --region '$REGION' --query 'Certificate.Status'"
  echo ""
  echo "⏰ Waiting for certificate validation..."
  echo "   This will wait until DNS records are added and validated"
  echo "   You can press Ctrl+C to cancel waiting"
  echo ""
  
  if aws acm wait certificate-validated --certificate-arn "$CERT_ARN" --region "$REGION"; then
    echo ""
    echo "✅ Certificate validated successfully!"
    echo ""
    setup_custom_domain
  else
    echo ""
    echo "❌ Certificate validation failed or timed out"
    echo "   Check DNS records and try again"
    echo ""
    echo "📝 Manual steps if you want to continue later:"
    echo "   1. Verify DNS records are added correctly"
    echo "   2. Wait for validation: aws acm wait certificate-validated --certificate-arn '$CERT_ARN' --region '$REGION'"
    echo "   3. Then run the setup steps shown above"
    exit 6
  fi
fi