import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

// =============================================================================
// CONFIGURATION
// =============================================================================
const config = new pulumi.Config();
const instanceType = config.get('ec2InstanceType') || 't3.micro';
const appPort = config.getNumber('appPort') || 8000; // Port your container will expose
const keyName = config.get('ec2KeyName'); // Optional existing key pair for SSH access
const rootVolumeSize = config.getNumber('rootVolumeSize') || 30; // GiB
const dockerImageName =
  config.get('dockerImageName') || 'getnuvo/mapping:latest'; // e.g. dockerhub repo/image:tag
const dockerHubUsername = config.get('dockerHubUsername') || 'getnuvo';
const dockerHubAccessToken = config.getSecret('dockerHubAccessToken'); // store as secret config

// Build a snippet for docker login only if creds provided
const dockerHubLoginSnippet = pulumi
  .all([dockerHubUsername, dockerHubAccessToken])
  .apply(([u, t]) => {
    if (u && t) {
      const safeToken = t.replace(/'/g, "'\"'\"'");
      return `echo '${safeToken}' | docker login -u '${u}' --password-stdin\n`;
    }
    return "echo 'Docker Hub credentials not provided; skipping docker login'\n";
  });

// =============================================================================
// NETWORK (Default VPC + a default subnet per AZ) - kept simple like index.ts
// =============================================================================
const defaultVpc = pulumi.output(aws.ec2.getVpc({ default: true }));
const defaultSubnetIds = defaultVpc.id.apply((vpcId) =>
  aws.ec2.getSubnets({
    filters: [
      { name: 'vpc-id', values: [vpcId] },
      { name: 'default-for-az', values: ['true'] },
    ],
  }),
);
const vpcCidrBlock = defaultVpc.apply((vpc) => vpc.cidrBlock);

// =============================================================================
// SECURITY GROUP
// =============================================================================
const ec2Sg = new aws.ec2.SecurityGroup('ec2-docker-sg', {
  vpcId: defaultVpc.id,
  description: 'Security group for Docker host instance',
  ingress: [
    {
      fromPort: appPort,
      toPort: appPort,
      protocol: 'tcp',
      cidrBlocks: [vpcCidrBlock],
      description: `App port ${appPort}`,
    },
    {
      fromPort: 22,
      toPort: 22,
      protocol: 'tcp',
      cidrBlocks: [vpcCidrBlock],
      description: 'SSH access',
    },
  ],
  egress: [
    {
      fromPort: 0,
      toPort: 0,
      protocol: '-1',
      cidrBlocks: ['0.0.0.0/0'],
      description: 'All outbound',
    },
  ],
});

// =============================================================================
// IAM ROLE + INSTANCE PROFILE (SSM access)
// =============================================================================
const ec2Role = new aws.iam.Role('ec2-docker-role', {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: 'ec2.amazonaws.com',
  }),
});
new aws.iam.RolePolicyAttachment('ec2-docker-role-ssm', {
  role: ec2Role.name,
  policyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
});
const instanceProfile = new aws.iam.InstanceProfile(
  'ec2-docker-instance-profile',
  { role: ec2Role.name },
);

// =============================================================================
// AMI (Latest Amazon Linux 2023 x86_64)
// =============================================================================
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

// =============================================================================
// USER DATA SCRIPT (Install Docker, login to Docker Hub if creds, run docker-compose)
// =============================================================================
const userData = pulumi.all([dockerHubLoginSnippet]).apply(
  ([loginSnippet]) => `#!/bin/bash
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
      - "${appPort}:${appPort}"
    environment:
      - NODE_ENV=production
      - PORT=${appPort}
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

// =============================================================================
// EC2 INSTANCE
// =============================================================================
const instance = new aws.ec2.Instance(
  'docker-host',
  {
    ami: ami.id,
    instanceType,
    subnetId: defaultSubnetIds.ids[0],
    vpcSecurityGroupIds: [ec2Sg.id],
    keyName: keyName || undefined,
    iamInstanceProfile: instanceProfile.name,
    userData: userData,
    associatePublicIpAddress: true,
    rootBlockDevice: {
      volumeSize: rootVolumeSize,
      volumeType: 'gp3',
      encrypted: true,
    },
    tags: { Name: 'docker-compose-host' },
  },
  {
    replaceOnChanges: ['userData'],
  },
);

// =============================================================================
// OUTPUTS
// =============================================================================
export const dockerHostInstanceId = instance.id;
export const dockerHostPublicDns = instance.publicDns;
export const dockerHostPrivateIp = instance.privateIp;
export const dockerSecurityGroupId = ec2Sg.id;
export const applicationPort = appPort;
export const imageConfigured = dockerImageName;
