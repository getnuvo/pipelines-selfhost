import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { initialLambdaFunctions } from './utils/lambda.deployment';

// Exports will be assigned inside run()
export let docdbEndpoint: pulumi.Output<string> | undefined;
export let docdbReaderEndpoint: pulumi.Output<string> | undefined;
export let docdbConnectionString: pulumi.Output<string> | undefined;
export let dnsRecord: any | undefined;

export const run = async () => {
  const config = new pulumi.Config();
  const prefix = config.get('prefix') || 'docdb';
  const masterUsername = config.get('docdbUsername') || 'master';
  const masterPassword = config.get('docdbPassword'); // secret required
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

  // const assetBucketName =
  //   config.get('assetBucketName') || 'dp-self-hosted-assets';
  // const emailDomain = config.get('sesEmailDomain') || '';
  // const emailBucket = new aws.s3.Bucket(assetBucketName, {
  //   acl: 'private',
  // });

  // // Add bucket policy to allow SES to write to the bucket
  // const bucketPolicy = new aws.s3.BucketPolicy(`${assetBucketName}-policy`, {
  //   bucket: emailBucket.bucket,
  //   policy: emailBucket.bucket.apply((bucketName) =>
  //     JSON.stringify({
  //       Version: '2012-10-17',
  //       Statement: [
  //         {
  //           Effect: 'Allow',
  //           Principal: { Service: 'ses.amazonaws.com' },
  //           Action: ['s3:PutObject', 's3:PutObjectAcl'],
  //           Resource: `arn:aws:s3:::${bucketName}/*`,
  //         },
  //       ],
  //     }),
  //   ),
  // });

  // // Create a new SES Domain Identity (no dkimSigningEnabled property)
  // const domainIdentity = new aws.ses.DomainIdentity(
  //   'DPSelfHostedDomainIdentity',
  //   {
  //     domain: emailDomain,
  //   },
  // );

  // const currentRuleSet = aws.ses.getActiveReceiptRuleSet({}).then((rs) => {
  //   if (!rs || !rs.ruleSetName) {
  //     const ruleSetName = 'dp-self-hosted-rule-set';
  //     const receiptRuleSet = new aws.ses.ReceiptRuleSet('receiptRuleSet', {
  //       ruleSetName,
  //     });
  //     return ruleSetName;
  //   }
  //   return rs.ruleSetName;
  // });

  // // Add the new rule to the duplicated rule set
  // const newReceiptRule = new aws.ses.ReceiptRule(
  //   'DpReceiptRule',
  //   {
  //     ruleSetName: currentRuleSet,
  //     enabled: true,
  //     recipients: ['wim@dp.getnuvo.ai'],
  //     s3Actions: [
  //       {
  //         position: 1,
  //         bucketName: emailBucket.bucket,
  //         objectKeyPrefix: 'emails/',
  //       },
  //     ],
  //     scanEnabled: true,
  //     tlsPolicy: 'Optional',
  //   },
  //   {
  //     dependsOn: [emailBucket, bucketPolicy],
  //   },
  // );

  // // Activate the duplicated rule set
  // const activateDuplicatedRuleSet = new aws.ses.ActiveReceiptRuleSet(
  //   'activateDuplicatedRuleSet',
  //   {
  //     ruleSetName: currentRuleSet,
  //   },
  // );

  // const awsRegion = aws.config.region || 'us-east-1';

  // Export the ARN, domain, verification token, and DKIM tokens as CNAME records
  // dnsRecord = {
  //   identityDomain: {
  //     name: `_amazonses.${emailDomain}`,
  //     type: 'TXT',
  //     value: domainIdentity.verificationToken,
  //   },
  //   inboundSmtpRecord: {
  //     name: emailDomain,
  //     type: 'MX',
  //     value: `10 inbound-smtp.${awsRegion}.amazonaws.com`,
  //   },
  // };

  await initialLambdaFunctions(docdbConnectionString);
};
