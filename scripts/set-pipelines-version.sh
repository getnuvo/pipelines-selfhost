#!/usr/bin/env bash
# Sets the Pipelines release version (ingestro/pipelines:<version>, and the AWS/Azure packages of
# the same release) in the example configs and guides.
#
#   scripts/set-pipelines-version.sh 1.6.0
#
# Run by .github/workflows/pipelines-release.yml when nuvo-serverless publishes a release.
set -euo pipefail

version="${1:-}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: $0 <release version>, e.g. 1.6.0 (got '${version}')" >&2
  exit 1
fi
cd "$(dirname "$0")/.."

# Only lines that hold a version: placeholders such as 'XXX' in the upgrade steps stay.
perl -pi -e "s/^(\s*pipeline-self-host:version: )'[0-9][^']*'/\${1}'${version}'/" \
  Pulumi.azure-docker.yaml.example docs/aws/guide.md docs/azure/guide.md
perl -pi -e "s/^version: '[0-9][^']*'/version: '${version}'/" deploy.answers.example.yaml
perl -pi -e "s/(\\\`<version>\\\` \(e\.g\. \\\`)[0-9]+\.[0-9]+\.[0-9]+/\${1}${version}/" \
  docs/azure-docker/terraform-handoff.md
perl -pi -e "s/(release images \(e\.g\. \\\`)[0-9]+\.[0-9]+\.[0-9]+/\${1}${version}/" \
  docs/azure-docker/guide.md
