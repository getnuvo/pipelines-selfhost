import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as apigateway from '@pulumi/aws-apigateway';
import { WaitForEfsTargets } from './efs-waiting-target';
import { LambdaEniWait } from './eip-waiting';

const config = new pulumi.Config();
const requiredScheduleFunction = ['execution-schedule', 'session-schedule'];
const scheduleFunctions: aws.lambda.Function[] = [];
let lambdaName: pulumi.Output<string> | undefined;
const functionPrefix = config.require('functionPrefix');

// TODO: replace with real function list request eg. with axios from a config service
const functionList = Promise.resolve({
  functions: [
    {
      url: 'https://test-azure-zip-bucket.s3.eu-central-1.amazonaws.com/0.3.4/aws/email-listener.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIASCOAPKIMLLI7VVVJ%2F20251003%2Feu-central-1%2Fs3%2Faws4_request&X-Amz-Date=20251003T033933Z&X-Amz-Expires=43200&X-Amz-Signature=e2f837c52d860bb65d45d208cc0a7253d95d602ff3e0a1b527080ba31bb5c666&X-Amz-SignedHeaders=host&x-id=GetObject',
      name: 'email-listener',
    },
    {
      url: 'https://test-azure-zip-bucket.s3.eu-central-1.amazonaws.com/0.3.4/aws/execute-fetch-input-data.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIASCOAPKIMLLI7VVVJ%2F20251003%2Feu-central-1%2Fs3%2Faws4_request&X-Amz-Date=20251003T033933Z&X-Amz-Expires=43200&X-Amz-Signature=036dcb5873f58440bb7ad492cc6689a4987720d67e8729bd678c01c4bb18f5f5&X-Amz-SignedHeaders=host&x-id=GetObject',
      name: 'execute-fetch-input-data',
    },
    {
      url: 'https://test-azure-zip-bucket.s3.eu-central-1.amazonaws.com/0.3.4/aws/execute-transform.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIASCOAPKIMLLI7VVVJ%2F20251003%2Feu-central-1%2Fs3%2Faws4_request&X-Amz-Date=20251003T033933Z&X-Amz-Expires=43200&X-Amz-Signature=9df9123daad69ada6e4f7e63a02ed3a8ff713c2448967b9081f43dd0af2fc206&X-Amz-SignedHeaders=host&x-id=GetObject',
      name: 'execute-transform',
    },
    {
      url: 'https://test-azure-zip-bucket.s3.eu-central-1.amazonaws.com/0.3.4/aws/execute-write-output-data.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIASCOAPKIMLLI7VVVJ%2F20251003%2Feu-central-1%2Fs3%2Faws4_request&X-Amz-Date=20251003T033933Z&X-Amz-Expires=43200&X-Amz-Signature=e733619e4b558a8a87f3c3db99f39fed2eb551f71bc4075e0ba74a1fbb4be54b&X-Amz-SignedHeaders=host&x-id=GetObject',
      name: 'execute-write-output-data',
    },
    {
      url: 'https://test-azure-zip-bucket.s3.eu-central-1.amazonaws.com/0.3.4/aws/execution-schedule.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIASCOAPKIMLLI7VVVJ%2F20251003%2Feu-central-1%2Fs3%2Faws4_request&X-Amz-Date=20251003T033933Z&X-Amz-Expires=43200&X-Amz-Signature=5dda2ca754bf461435043c3c7959a7803de9aedeccdd35c4daadbf3605bf2ca8&X-Amz-SignedHeaders=host&x-id=GetObject',
      name: 'execution-schedule',
    },
    {
      url: 'https://test-azure-zip-bucket.s3.eu-central-1.amazonaws.com/0.3.4/aws/fetch-input-data.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIASCOAPKIMLLI7VVVJ%2F20251003%2Feu-central-1%2Fs3%2Faws4_request&X-Amz-Date=20251003T033933Z&X-Amz-Expires=43200&X-Amz-Signature=e5c984511b0347df1538de9eb12778f5be25c44ce10ca2e5a60975a53f9aa5b0&X-Amz-SignedHeaders=host&x-id=GetObject',
      name: 'fetch-input-data',
    },
    {
      url: 'https://test-azure-zip-bucket.s3.eu-central-1.amazonaws.com/0.3.4/aws/management.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIASCOAPKIMLLI7VVVJ%2F20251003%2Feu-central-1%2Fs3%2Faws4_request&X-Amz-Date=20251003T033933Z&X-Amz-Expires=43200&X-Amz-Signature=54bae09b37ddc64931c79d11f8def231995f13874d9e8df78370766f24026987&X-Amz-SignedHeaders=host&x-id=GetObject',
      name: 'management',
    },
    {
      url: 'https://test-azure-zip-bucket.s3.eu-central-1.amazonaws.com/0.3.4/aws/session-schedule.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIASCOAPKIMLLI7VVVJ%2F20251003%2Feu-central-1%2Fs3%2Faws4_request&X-Amz-Date=20251003T033933Z&X-Amz-Expires=43200&X-Amz-Signature=c7bc9c22a383521ed26a2671603252b647cfc6feb07af586d4f0e04bfbe5587a&X-Amz-SignedHeaders=host&x-id=GetObject',
      name: 'session-schedule',
    },
    {
      url: 'https://test-azure-zip-bucket.s3.eu-central-1.amazonaws.com/0.3.4/aws/transform.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIASCOAPKIMLLI7VVVJ%2F20251003%2Feu-central-1%2Fs3%2Faws4_request&X-Amz-Date=20251003T033933Z&X-Amz-Expires=43200&X-Amz-Signature=67b98af05135112683c6a5f9e91cc634acc50388a2bddf662ffd8fe675b64918&X-Amz-SignedHeaders=host&x-id=GetObject',
      name: 'transform',
    },
  ],
});

const getHandler = (functionName: string) => {
  switch (functionName) {
    case 'email-listener':
      return 'dist/aws-functions/email-listener.handler';
    case 'execute-fetch-input-data':
      return 'dist/aws-functions/execute.executeFetchData';
    case 'execute-transform':
      return 'dist/aws-functions/execute.executeTransformData';
    case 'execute-write-output-data':
      return 'dist/aws-functions/execute.executeWriteOutputData';
    case 'execution-schedule':
      return 'dist/aws-functions/schedule.executionScheduler';
    case 'fetch-input-data':
      return 'dist/aws-functions/input-connector.fetchInputData';
    case 'session-schedule':
      return 'dist/aws-functions/schedule.clearCacheHandler';
    case 'transform':
      return 'dist/aws-functions/transformation.transformDataWithFile';
    default:
      return 'dist/aws-functions/index.handler';
  }
};

const initialAPIGateway = async (managementFunction: any) => {
  const endpoint = await new apigateway.RestAPI('dp-self-hosted-management', {
    routes: [
      {
        path: '{route+}',
        method: 'ANY',
        eventHandler: managementFunction,
      },
    ],
    stageName: 'develop',
  });
  await endpoint.deployment;

  endpoint.url.apply((url) => {
    console.log('API Gateway endpoint URL:', url);
  });

  return endpoint;
};

export const initialScheduleService = async () => {
  const schedulerRole = new aws.iam.Role(`${functionPrefix}-scheduler-role`, {
    assumeRolePolicy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'scheduler.amazonaws.com' },
          Action: 'sts:AssumeRole',
        },
      ],
    }),
  });

  pulumi.all(scheduleFunctions.map((f) => f.arn)).apply((arns) => {
    if (arns.length === 0) return;
    return new aws.iam.RolePolicy(`${functionPrefix}-scheduler-invoke-all`, {
      role: schedulerRole.id,
      policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['lambda:InvokeFunction'],
            Resource: arns,
          },
        ],
      }),
    });
  });

  // NOTE: trigger functions are invoked by EventBridge rules, cannot be part of data pipeline directly
  scheduleFunctions.forEach((fn, idx) => {
    console.log('Scheduling function:', fn.name);
    // Stable unique logical + AWS name
    const resourceName = `${functionPrefix}-schedule-${fn.name}-${idx}`;
    const scheduleName = pulumi.interpolate`${functionPrefix}-${fn.name}-every-5m`;

    new aws.scheduler.Schedule(resourceName, {
      name: scheduleName,
      description: pulumi.interpolate`Schedule to trigger ${fn.name} every 5 minutes`,
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: 'rate(5 minutes)',
      target: {
        arn: fn.arn,
        roleArn: schedulerRole.arn,
        input: pulumi.jsonStringify({
          trigger: 'scheduled',
          every: '5m',
          function: fn.name,
        }),
      },
    });
  });
};

/**
 *
 * @returns void
 * Main function to initialize all Lambda functions, API Gateway, and Schedule service
 */
export const initialLambdaFunctions = async () => {
  let managementFunction;
  let emailListenerFunction: aws.lambda.Function | undefined;
  const createdFunctions: aws.lambda.Function[] = [];

  const functionUrls = (await functionList).functions;
  const defaultVpc = pulumi.output(aws.ec2.getVpc({ default: true }));
  const defaultSubnetIds = defaultVpc.id.apply((vpcId) =>
    aws.ec2.getSubnets({
      filters: [
        { name: 'vpc-id', values: [vpcId] },
        { name: 'default-for-az', values: ['true'] },
      ],
    }),
  );
  const lambdaSg = new aws.ec2.SecurityGroup(`${functionPrefix}-lambda-sg`, {
    vpcId: defaultVpc.id,
    description: 'Allow all outbound traffic for Lambda',
    egress: [
      {
        fromPort: 0,
        toPort: 0,
        protocol: '-1', // All protocols
        cidrBlocks: ['0.0.0.0/0'], // To the internet and other VPC resources
      },
    ],
  });

  // --------------------- EFS Setup ---------------------
  // TODO Improve this issue -> Please wait for them to become available and try the request again.
  // EFS Security Group (created before mount targets)
  const efsSg = new aws.ec2.SecurityGroup('efs-sg', {
    vpcId: defaultVpc.id,
    description: 'Allow all outbound traffic for Lambda',
    egress: [
      {
        fromPort: 0,
        toPort: 0,
        protocol: '-1', // All protocols
        cidrBlocks: ['0.0.0.0/0'], // To the internet and other VPC resources
      },
    ],
    ingress: [
      {
        fromPort: 2049,
        toPort: 2049,
        protocol: 'tcp',
        cidrBlocks: [defaultVpc.apply((vpc) => vpc.cidrBlock)],
      },
    ],
  });

  const efs = new aws.efs.FileSystem(`${functionPrefix}-lambda-efs`, {
    tags: { Application: 'example' },
  });

  const efsMountTargets: aws.efs.MountTarget[] = [];
  defaultSubnetIds.ids.apply((subnetIds) =>
    subnetIds.forEach((subnetId, i) => {
      const mt = new aws.efs.MountTarget(
        `${functionPrefix}-lambda-efs-mt-${i}`,
        {
          fileSystemId: efs.id,
          subnetId,
          securityGroups: [efsSg.id],
        },
      );
      efsMountTargets.push(mt);
    }),
  );

  const waiter = new WaitForEfsTargets(
    'efs-wait',
    {
      fileSystemId: efs.id,
      region: aws.config.region,
    },
    { dependsOn: efsMountTargets },
  );

  const efsAccessPoint = new aws.efs.AccessPoint(
    `${functionPrefix}-lambda-efs-ap`,
    {
      fileSystemId: efs.id,
      rootDirectory: {
        path: '/hyperformula-column',
        creationInfo: {
          ownerGid: 1000,
          ownerUid: 1000,
          permissions: '0777',
        },
      },
      posixUser: {
        gid: 1000,
        uid: 1000,
      },
    },
    { dependsOn: waiter },
  );
  // --------------------- End EFS Setup ---------------------

  // --------------------- SETUP IAM ROLE ---------------------
  const awsIamRole = new aws.iam.Role('aws-self-hosted-example-role', {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
      Service: 'lambda.amazonaws.com',
    }),
  });

  new aws.iam.RolePolicyAttachment('lambda-basic-exec', {
    role: awsIamRole.name,
    policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
  });

  new aws.iam.RolePolicyAttachment('lambda-vpc-access', {
    role: awsIamRole.name,
    policyArn: aws.iam.ManagedPolicy.AWSLambdaVPCAccessExecutionRole,
  });

  // Custom EFS policy for Lambda
  const lambdaEfsPolicy = new aws.iam.Policy('lambda-efs-specific-policy', {
    description:
      'Allow Lambda to access only the specific EFS file system and access point',
    policy: pulumi.all([efs.arn, efsAccessPoint.arn]).apply(([efsArn, apArn]) =>
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: [
              'elasticfilesystem:ClientMount',
              'elasticfilesystem:ClientWrite',
            ],
            Resource: [efsArn, apArn],
          },
        ],
      }),
    ),
  });
  new aws.iam.RolePolicyAttachment('lambdaEfsAccessPolicy', {
    role: awsIamRole.name,
    policyArn: lambdaEfsPolicy.arn,
  });

  for (let i = 0; i < functionUrls.length; i++) {
    const loggingService = new aws.cloudwatch.LogGroup(
      `${functionPrefix}-${functionUrls[i].name}-log`,
      {
        name: `/aws/lambda/${functionPrefix}-${functionUrls[i].name}`,
        retentionInDays: 14,
        tags: {
          Application: 'example',
        },
      },
    );

    const functionName = `${functionPrefix}-${functionUrls[i].name}`;
    // Mount EFS only for email-listener and execute-fetch-input-data
    const shouldMountEfs = [
      'management',
      'transform',
      'execute-fetch-input-data',
      'execute-transform',
      'fetch-input-data',
    ].includes(functionUrls[i].name);
    const fn = new aws.lambda.Function(
      functionName,
      {
        name: functionName,
        code: new pulumi.asset.RemoteArchive(functionUrls[i].url),
        role: awsIamRole.arn,
        handler: getHandler(functionUrls[i].name),
        memorySize: 10240,
        timeout: 900,
        architectures: ['x86_64'],
        ephemeralStorage: { size: 4096 },
        packageType: 'Zip',
        runtime: aws.lambda.Runtime.NodeJS20dX,
        tracingConfig: {
          mode: 'Active',
        },
        loggingConfig: {
          logFormat: 'JSON',
          applicationLogLevel: 'INFO',
          systemLogLevel: 'WARN',
        },
        vpcConfig: {
          subnetIds: defaultSubnetIds.ids,
          securityGroupIds: [lambdaSg.id],
        },
        environment: {
          variables: {
            JWT_SECRET_KEY: config.require('JWT_SECRET_KEY'),
            USER_PLATFORM_DB_NAME: config.require('USER_PLATFORM_DB_NAME'),
            DATA_PIPELINE_DB_NAME: config.require('DATA_PIPELINE_DB_NAME'),
            DATA_PIPELINE_LOG_DB_NAME: config.require(
              'DATA_PIPELINE_LOG_DB_NAME',
            ),
            USER_PLATFORM_DB_HOST: config.require('USER_PLATFORM_DB_HOST'),
            USER_PLATFORM_DB_USERNAME: config.require(
              'USER_PLATFORM_DB_USERNAME',
            ),
            USER_PLATFORM_DB_PASSWORD: config.require(
              'USER_PLATFORM_DB_PASSWORD',
            ),
            S3_CONNECTOR_SECRET_KEY: config.require('S3_CONNECTOR_SECRET_KEY'),
            AWS_STORAGE_REGION: config.require('AWS_REGION'),
            AWS_STORAGE_KEY: config.require('AWS_ACCESS_KEY'),
            AWS_STORAGE_HASH: config.require('AWS_SECRET_KEY'),
            AWS_S3_BUCKET: config.require('AWS_S3_BUCKET'),
            HYPERFORMULA_LICENSE_KEY: config.require(
              'HYPERFORMULA_LICENSE_KEY',
            ),
            PUSHER_APP_ID: config.require('PUSHER_APP_ID'),
            PUSHER_KEY: config.require('PUSHER_KEY'),
            PUSHER_SECRET: config.require('PUSHER_SECRET'),
            SERVERLESS_TRANSFORM_FUNCTION_NAME: `${functionPrefix}-transform`,
            SERVERLESS_EXECUTE_FETCH_INPUT_DATA_FUNCTION_NAME: `${functionPrefix}-execute-fetch-input-data`,
            SERVERLESS_EXECUTE_TRANSFORM_FUNCTION_NAME: `${functionPrefix}-execute-transform`,
            SERVERLESS_FETCH_INPUT_DATA_FUNCTION_NAME: `${functionPrefix}-fetch-input-data`,
            SERVERLESS_EXECUTE_WRITE_OUTPUT_DATA_FUNCTION_NAME: `${functionPrefix}-execute-write-output-data`,
            BREVO_API_KEY: config.require('BREVO_API_KEY'),
            MAPPING_BASE_URL: config.require('MAPPING_BASE_URL'),
            DATA_PIPELINE_DB_URI: config.require('DATA_PIPELINE_DB_URI'),
          },
        },
        ...(shouldMountEfs
          ? {
              fileSystemConfig: {
                arn: efsAccessPoint.arn,
                localMountPath: '/mnt/hyperformula-column',
              },
            }
          : {}),
      },
      {
        dependsOn: [loggingService, efsAccessPoint, waiter],
      },
    );

    if (functionUrls[i].name === 'management') {
      lambdaName = fn.name;
      managementFunction = fn;
    }

    if (requiredScheduleFunction.includes(functionUrls[i].name)) {
      scheduleFunctions.push(fn);
    }

    if (functionUrls[i].name === 'email-listener') {
      emailListenerFunction = fn;
    }
    createdFunctions.push(fn);
  }

  // Add S3 trigger for email-listener
  if (emailListenerFunction) {
    const s3BucketName = config.require('AWS_S3_BUCKET');
    const s3Bucket = aws.s3.Bucket.get('trigger-bucket', s3BucketName);

    // Permission for S3 to invoke Lambda
    new aws.lambda.Permission('email-listener-s3-permission', {
      action: 'lambda:InvokeFunction',
      function: emailListenerFunction.name,
      principal: 's3.amazonaws.com',
      sourceArn: s3Bucket.arn,
    });

    // S3 notification for object created
    new aws.s3.BucketNotification('email-listener-s3-notification', {
      bucket: s3Bucket.id,
      lambdaFunctions: [
        {
          lambdaFunctionArn: emailListenerFunction.arn,
          events: ['s3:ObjectCreated:*'],
          filterPrefix: 'emails/',
        },
      ],
    });
  }

  // ------------- SETUP EIP FOR LAMBDA -------------
  // Run EIP association after all Lambda functions and ENIs are created
  const eniWait = pulumi.all([lambdaSg.id, defaultSubnetIds.ids, waiter]).apply(
    ([sgId, subnetIds]) =>
      new LambdaEniWait(
        `${functionPrefix}-lambda-eni-wait`,
        {
          securityGroupId: sgId,
          subnetIds,
        },
        { dependsOn: [...createdFunctions, waiter] },
      ),
  );

  eniWait.eniIds.apply((eniIds) => {
    if (!eniIds || eniIds.length === 0) {
      throw new Error('No ENIs available for EIP association');
    }

    eniIds.forEach((eniId: string, i: number) => {
      const eip = new aws.ec2.Eip(
        `${functionPrefix}-lambda-nic-eip-${i}`,
        { vpc: true },
        { dependsOn: [eniWait] },
      );

      new aws.ec2.EipAssociation(
        `${functionPrefix}-lambda-nic-eip-assoc-${i}`,
        {
          networkInterfaceId: eniId,
          allocationId: eip.id,
        },
        { dependsOn: [eip] },
      );
    });
  });
  // ------------- END SETUP EIP FOR LAMBDA -------------

  // ------------- SETUP API GATEWAY ---------------
  if (managementFunction) {
    await initialAPIGateway(managementFunction);
  }
  // ------------- END SETUP API GATEWAY -------------

  // --------------------- SETUP SCHEDULE ---------------------
  await initialScheduleService();
  // --------------------- END SETUP SCHEDULE ---------------------

  return;
};

export const getLambdaName = () => lambdaName;
