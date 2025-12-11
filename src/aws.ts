import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { SESClient, ListReceiptRuleSetsCommand } from '@aws-sdk/client-ses';
import {
  initialLambdaFunctions,
  initS3Bucket,
} from './utils/lambda.deployment';

// Exports will be assigned inside run()
export let docdbEndpoint: pulumi.Output<string> | undefined;
export let docdbReaderEndpoint: pulumi.Output<string> | undefined;
export let docdbConnectionString: pulumi.Output<string> | undefined;
export let dnsRecord: any | undefined;

export const run = async () => {
  const config = new pulumi.Config();
  const prefix = config.require('prefix');
  const masterUsername = config.get('docdbUsername') || 'master';
  const masterPassword = config.require('docdbPassword'); // secret required
  const instanceClass = config.get('docdbInstanceClass') || 'db.t3.medium';
  const engineVersion = config.get('docdbEngineVersion') || '5.0.0'; // DocumentDB compatible w/ MongoDB 5.0
  // Optional overrides for backup schedule & retention (defaults: daily @07:00 UTC, 7 days)
  const backupCron = config.get('docdbBackupCron') || 'cron(0 7 * * ? *)';
  const backupRetentionDays = config.getNumber('docdbBackupRetentionDays') || 7;

  // ---------------- DEFAULT VPC & EXISTING SUBNETS ----------------
  const defaultVpc = pulumi.output(aws.ec2.getVpc({ default: true }));
  const defaultSubnetIds = defaultVpc
    .apply((v) =>
      aws.ec2.getSubnets({
        filters: [{ name: 'vpc-id', values: [v.id] }],
      }),
    )
    .apply((res: aws.ec2.GetSubnetsResult) => res.ids);

  // Security Group – allow access from allowed CIDR or entire VPC CIDR
  const allowedCidr = config.get('docdbAllowedCidr'); // e.g. "x.y.z.w/32"
  const sg = new aws.ec2.SecurityGroup(`${prefix}-sg`, {
    vpcId: defaultVpc.apply((v) => v.id),
    description: 'DocumentDB access',
    ingress: [
      {
        protocol: 'tcp',
        fromPort: 27017,
        toPort: 27017,
        cidrBlocks: allowedCidr
          ? [allowedCidr]
          : [defaultVpc.apply((v) => v.cidrBlock)],
        description: 'Mongo (DocumentDB) port',
      },
    ],
    egress: [
      { protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] },
    ],
    tags: { Name: `${prefix}-sg` },
  });

  // Subnet group (use all default VPC subnets to span AZs)
  const subnetGroup = new aws.docdb.SubnetGroup(`${prefix}-subnet-group`, {
    subnetIds: defaultSubnetIds,
    tags: { Name: `${prefix}-subnet-group` },
  });

  // Parameter group
  const paramGroup = new aws.docdb.ClusterParameterGroup(
    `${prefix}-param-group`,
    {
      family: 'docdb5.0',
      parameters: [{ name: 'tls', value: 'enabled' }],
      description: 'Custom parameter group for DocumentDB',
    },
  );

  // Cluster
  const cluster = new aws.docdb.Cluster(`${prefix}-cluster`, {
    engine: 'docdb',
    engineVersion: engineVersion,
    masterUsername: masterUsername,
    masterPassword: masterPassword,
    dbSubnetGroupName: subnetGroup.name,
    vpcSecurityGroupIds: [sg.id],
    storageEncrypted: true,
    backupRetentionPeriod: backupRetentionDays, // updated to 7 days (configurable)
    preferredBackupWindow: '07:00-09:00',
    preferredMaintenanceWindow: 'sun:04:00-sun:06:00',
    clusterIdentifier: `${prefix}-cluster`,
    applyImmediately: true,
    port: 27017,
    skipFinalSnapshot: true,
    dbClusterParameterGroupName: paramGroup.name,
    tags: { Name: `${prefix}-cluster` },
  });

  // Instance
  new aws.docdb.ClusterInstance(`${prefix}-instance-1`, {
    clusterIdentifier: cluster.id,
    instanceClass: instanceClass,
    applyImmediately: true,
    engine: 'docdb',
    identifier: `${prefix}-instance-1`,
  });

  // ---------------- AWS BACKUP (Daily, 7-day retention) ----------------
  // IAM Role for AWS Backup service
  const backupRole = new aws.iam.Role(`${prefix}-backup-role`, {
    assumeRolePolicy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'backup.amazonaws.com' },
          Action: 'sts:AssumeRole',
        },
      ],
    }),
    tags: { Name: `${prefix}-backup-role` },
  });

  // Attach AWS managed policies needed for backup (and optional restore)
  new aws.iam.RolePolicyAttachment(`${prefix}-backup-role-backup`, {
    role: backupRole.name,
    policyArn:
      'arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup',
  });
  new aws.iam.RolePolicyAttachment(`${prefix}-backup-role-restore`, {
    role: backupRole.name,
    policyArn:
      'arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores',
  });

  // Backup vault
  const backupVault = new aws.backup.Vault(`${prefix}-backup-vault`, {
    tags: { Name: `${prefix}-backup-vault` },
  });

  // Backup plan (daily schedule, 7 day retention configurable)
  const backupPlan = new aws.backup.Plan(`${prefix}-backup-plan`, {
    rules: [
      {
        ruleName: `${prefix}-daily-backup`,
        targetVaultName: backupVault.name,
        schedule: backupCron, // daily cron
        lifecycle: {
          deleteAfter: backupRetentionDays,
        },
      },
    ],
    tags: { Name: `${prefix}-backup-plan` },
  });

  // Selection adding the DocumentDB cluster
  new aws.backup.Selection(
    `${prefix}-backup-selection`,
    {
      iamRoleArn: backupRole.arn,
      planId: backupPlan.id,
      resources: [cluster.arn],
    },
    { dependsOn: [cluster] },
  );

  // Assign outputs
  docdbEndpoint = cluster.endpoint;
  docdbReaderEndpoint = cluster.readerEndpoint;
  docdbConnectionString = pulumi.interpolate`mongodb://${masterUsername}:${masterPassword}@${cluster.endpoint}:27017/?tls=true&replicaSet=rs0&readPreference=secondaryPreferred&retryWrites=false`;

  const s3Bucket = await initS3Bucket();
  await initialLambdaFunctions(docdbConnectionString, s3Bucket);

  const emailDomain = config.get('customDomain');

  if (emailDomain) {
    // Add bucket policy to allow SES to write to the bucket
    const bucketPolicy = new aws.s3.BucketPolicy(`${prefix}-s3-ses-policy`, {
      bucket: s3Bucket.bucket,
      policy: s3Bucket.bucket.apply((bucketName) =>
        JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Service: 'ses.amazonaws.com' },
              Action: ['s3:PutObject', 's3:PutObjectAcl'],
              Resource: `arn:aws:s3:::${bucketName}/*`,
            },
          ],
        }),
      ),
    });

    // Create a new SES Domain Identity (no dkimSigningEnabled property)
    const domainIdentity = new aws.ses.DomainIdentity(
      `${prefix}-domain-identity`,
      {
        domain: emailDomain,
      },
    );

    const awsProfile = config.get('profile');
    const sesClient = new SESClient({
      region: aws.config.region,
      profile: awsProfile,
    });
    const listRuleSets = async () => {
      const result = await sesClient.send(new ListReceiptRuleSetsCommand({}));
      return result.RuleSets?.map((ruleSet) => ruleSet.Name || '') || [];
    };

    const existingRuleSets = await listRuleSets();
    const suffixes = existingRuleSets
      .map((name) => {
        const match = name.match(/\d+$/);
        return match ? parseInt(match[0], 10) : 0;
      })
      .filter((num) => num > 0);
    const nextSuffix = suffixes.length > 0 ? Math.max(...suffixes) + 1 : 1;
    const targetRuleSetName = `${prefix}-receipt-rule-set-${nextSuffix}`;

    const ruleSetExists = existingRuleSets.includes(targetRuleSetName);
    let currentRuleSet = targetRuleSetName;
    if (!ruleSetExists) {
      new aws.ses.ReceiptRuleSet(`${prefix}-receipt-rule-set-${nextSuffix}`, {
        ruleSetName: targetRuleSetName,
      });
    }

    // Add the new rule to the duplicated rule set
    const testReceiptRule = new aws.ses.ReceiptRule(
      `${prefix}-test-receipt-rule`,
      {
        ruleSetName: currentRuleSet,
        enabled: true,
        recipients: [`test@${emailDomain}`],
        s3Actions: [
          {
            position: 1,
            bucketName: s3Bucket.bucket,
            objectKeyPrefix: 'emails/test/',
          },
        ],
        scanEnabled: true,
        tlsPolicy: 'Optional',
      },
      {
        dependsOn: [s3Bucket, bucketPolicy],
      },
    );
    const executeReceiptRule = new aws.ses.ReceiptRule(
      `${prefix}-execute-receipt-rule`,
      {
        ruleSetName: currentRuleSet,
        enabled: true,
        recipients: [`execute@${emailDomain}`],
        s3Actions: [
          {
            position: 2,
            bucketName: s3Bucket.bucket,
            objectKeyPrefix: 'emails/execute/',
          },
        ],
        scanEnabled: true,
        tlsPolicy: 'Optional',
      },
      {
        dependsOn: [s3Bucket, bucketPolicy],
      },
    );

    // Activate the duplicated rule set
    const activateDuplicatedRuleSet = new aws.ses.ActiveReceiptRuleSet(
      `${prefix}-activate-duplicated-rule-set`,
      {
        ruleSetName: currentRuleSet,
      },
      {
        dependsOn: [testReceiptRule, executeReceiptRule],
      },
    );

    const awsRegion = aws.config.region || 'us-east-1';

    // Export the ARN, domain, verification token, and DKIM tokens as CNAME records
    domainIdentity.verificationToken.apply((token) => {
      console.log('DNS Records: ', {
        identityDomain: {
          name: `_amazonses.${emailDomain}`,
          type: 'TXT',
          value: token,
        },
        inboundSmtpRecord: {
          name: emailDomain,
          type: 'MX',
          value: `10 inbound-smtp.${awsRegion}.amazonaws.com`,
        },
      });
    });
  }
};
