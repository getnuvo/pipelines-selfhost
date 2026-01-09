import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { Bucket } from '@pulumi/aws/s3';
import { Output } from '@pulumi/pulumi';
import { serializationConfigValue } from './string';

const config = new pulumi.Config();
const functionPrefix = config.require('prefix');
const dockerImageName =
  config.get('dockerImageName') || 'getnuvo/mapping:latest'; // e.g. dockerhub repo/image:tag
const dockerHubUsername = config.get('dockerHubUsername') || 'getnuvo';
const instanceType = config.get('ec2InstanceType') || 't3.xlarge';
const rootVolumeSize = config.getNumber('rootVolumeSize') || 30; // GiB

const mappingLlmProvider = config.get('mappingLlmProvider') || 'AZURE';
const mappingLlmTemperature = config.getNumber('mappingLlmTemperature') ?? 0;
const mappingAzureOpenaiApiKey = config.get('mappingAzureOpenaiApiKey') || '';
const mappingAzureOpenaiEndpoint =
  config.get('mappingAzureOpenaiEndpoint') || '';
const mappingAzureOpenaiApiVersion =
  config.get('mappingAzureOpenaiApiVersion') || '2024-10-21';
const mappingAzureOpenaiDeploymentName =
  config.get('mappingAzureOpenaiDeploymentName') || 'gpt-4o-mini';
const mappingAwsBedrockModelId =
  config.get('mappingAwsBedrockModelId') ||
  'anthropic.claude-3-haiku-20240307-v1:0';
const mappingAwsBedrockAccessKeyId =
  config.get('mappingAwsBedrockAccessKeyId') || '';
const mappingAwsBedrockSecretAccessKey =
  config.get('mappingAwsBedrockSecretAccessKey') || '';
const mappingAwsBedrockRegion = config.get('mappingAwsBedrockRegion') || '';
const mappingS3Region = config.require('AWS_REGION');
const mappingS3AccessKeyId = config.require('AWS_ACCESS_KEY');
const mappingS3SecretAccessKey = config.require('AWS_SECRET_KEY');

/**
 *
 * @returns void
 * Main function to initialize mapping module instance
 */
export const initialMappingModule = async (
  dockerToken: string,
  s3Bucket: Bucket,
) => {
  const defaultVpc = pulumi.output(aws.ec2.getVpc({ default: true }));
  const defaultSubnetIds = defaultVpc.id.apply((vpcId) =>
    aws.ec2.getSubnets({
      filters: [
        { name: 'vpc-id', values: [vpcId] },
        { name: 'default-for-az', values: ['true'] },
      ],
    }),
  );
  const mappingModuleSg = new aws.ec2.SecurityGroup(
    `${functionPrefix}-mapping-module-sg`,
    {
      vpcId: defaultVpc.id,
      description: 'Allow traffic for Mapping Module',
      ingress: [
        {
          fromPort: 8000,
          toPort: 8000,
          protocol: 'tcp',
          cidrBlocks: [defaultVpc.apply((vpc) => vpc.cidrBlock)], // Allow VPC CIDR
        },
      ],
      egress: [
        {
          fromPort: 0,
          toPort: 0,
          protocol: '-1',
          cidrBlocks: ['0.0.0.0/0'],
        },
      ],
    },
  );

  const ec2Role = new aws.iam.Role(`${functionPrefix}-ec2-docker-role`, {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
      Service: 'ec2.amazonaws.com',
    }),
  });
  new aws.iam.RolePolicyAttachment(`${functionPrefix}-ec2-docker-role-ssm`, {
    role: ec2Role.name,
    policyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
  });
  const instanceProfile = new aws.iam.InstanceProfile(
    `${functionPrefix}-ec2-docker-instance-profile`,
    { role: ec2Role.name },
  );

  const ami = pulumi.output(
    aws.ec2.getAmi({
      owners: ['amazon'],
      mostRecent: true,
      filters: [
        { name: 'name', values: ['al2023-ami-*-x86_64'] },
        { name: 'architecture', values: ['x86_64'] },
        { name: 'virtualization-type', values: ['hvm'] },
      ],
    }),
  );

  const instanceName = `${functionPrefix}-ingestro-mapping-module`;
  const instance = new aws.ec2.Instance(
    instanceName,
    {
      ami: ami.id,
      instanceType,
      subnetId: defaultSubnetIds.ids[0],
      vpcSecurityGroupIds: [mappingModuleSg.id],
      iamInstanceProfile: instanceProfile.name,
      userData: userData(dockerToken, s3Bucket.bucket),
      associatePublicIpAddress: true,
      rootBlockDevice: {
        volumeSize: rootVolumeSize,
        volumeType: 'gp3',
        encrypted: true,
      },
      tags: { Name: instanceName },
    },
    {
      replaceOnChanges: ['userData'],
      dependsOn: [s3Bucket],
    },
  );

  return instance.privateIp.apply((ip) => `http://${ip}:8000`);
};

// Build a snippet for docker login only if creds provided
const dockerHubLoginSnippet = (dockerToken: string) =>
  pulumi.all([dockerHubUsername]).apply(([u]) => {
    if (u && dockerToken) {
      const safeToken = dockerToken.replace(/'/g, "'\"'\"'");
      return `echo '${safeToken}' | docker login -u '${u}' --password-stdin\n`;
    }
    return "echo 'Docker Hub credentials not provided; skipping docker login'\n";
  });

const userData = (dockerToken: string, bucketName: Output<string>) =>
  pulumi.all([dockerHubLoginSnippet(dockerToken), bucketName]).apply(
    ([loginSnippet, s3BucketName]) => `#!/bin/bash
set -xe
exec > >(tee /var/log/user-data.log|logger -t user-data ) 2>&1

microdnf update -y || dnf update -y || true
microdnf install -y docker jq awscli tar gzip || dnf install -y docker jq awscli tar gzip
systemctl enable docker
systemctl start docker
usermod -aG docker ec2-user || true

# Docker Hub login (conditional)
${loginSnippet}
# Application directory
mkdir -p /home/ec2-user/app
cd /home/ec2-user/app

cat > docker-compose.yml <<'EOF'
version: '3.8'
services:
  app:
    image: ${dockerImageName}
    restart: always
    ports:
      - "8000:8000"
    environment:
      - NODE_ENV=production
      - MAPPING_PORT=8000
      - MAPPING_LLM_PROVIDER=${serializationConfigValue(mappingLlmProvider)}
      - MAPPING_LLM_TEMPERATURE=${mappingLlmTemperature}
      - MAPPING_AZURE_OPENAI_API_KEY=${serializationConfigValue(mappingAzureOpenaiApiKey)}
      - MAPPING_AZURE_OPENAI_ENDPOINT=${serializationConfigValue(mappingAzureOpenaiEndpoint)}
      - MAPPING_AZURE_OPENAI_API_VERSION=${serializationConfigValue(mappingAzureOpenaiApiVersion)}
      - MAPPING_AZURE_OPENAI_DEPLOYMENT_NAME=${serializationConfigValue(mappingAzureOpenaiDeploymentName)}
      - MAPPING_AWS_BEDROCK_MODEL_ID=${serializationConfigValue(mappingAwsBedrockModelId)}
      - MAPPING_AWS_BEDROCK_ACCESS_KEY_ID=${serializationConfigValue(mappingAwsBedrockAccessKeyId)}
      - MAPPING_AWS_BEDROCK_SECRET_ACCESS_KEY=${serializationConfigValue(mappingAwsBedrockSecretAccessKey)}
      - MAPPING_AWS_BEDROCK_REGION=${serializationConfigValue(mappingAwsBedrockRegion)}
      - MAPPING_S3_REGION=${serializationConfigValue(mappingS3Region)}
      - MAPPING_S3_ACCESS_KEY_ID=${serializationConfigValue(mappingS3AccessKeyId)}
      - MAPPING_S3_SECRET_ACCESS_KEY=${serializationConfigValue(mappingS3SecretAccessKey)}
      - MAPPING_BUCKET_NAME_PIPELINE=${s3BucketName}

EOF
chown ec2-user:ec2-user docker-compose.yml

# Pull image (ignore failure if not yet pushed)
(docker pull ${dockerImageName} || true)

# Ensure docker compose plugin
if ! docker compose version >/dev/null 2>&1; then
  echo "Installing docker compose plugin..."
  mkdir -p /usr/lib/docker/cli-plugins
  curl -L "https://github.com/docker/compose/releases/download/v2.27.0/docker-compose-linux-x86_64" -o /usr/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/lib/docker/cli-plugins/docker-compose
fi

sudo -u ec2-user docker compose up -d

cat > /etc/systemd/system/docker-compose-app.service <<'UNIT'
[Unit]
Description=Docker Compose Application Service
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/ec2-user/app
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable docker-compose-app.service

echo "User data complete"
`,
  );
