import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as apigateway from '@pulumi/aws-apigateway';
import { WaitForEfsTargets } from './efs-waiting-target';
import { LambdaEniWait } from './eip-waiting';
import { default as axios } from 'axios';
import { initialMappingModule } from './mapping.deployment';
import { Bucket } from '@pulumi/aws/s3';

const config = new pulumi.Config();
const requiredScheduleFunction = ['execution-schedule', 'session-schedule'];
const scheduleFunctions: aws.lambda.Function[] = [];
let lambdaName: pulumi.Output<string> | undefined;
const functionPrefix = config.require('prefix');
const codePipelineVersion = config.get('version') || '1.0.0';
const existingS3Bucket = config.get('AWS_S3_BUCKET');
let dockerToken: string;
let s3BucketName: string;

const fetchFunctionList = async () => {
  const url = `https://api-gateway.ingestro.com/dp/api/v1/auth/self-host-deployment`;
  const body = {
    version: codePipelineVersion,
    provider: 'AWS',
    license_key: config.require('INGESTRO_LICENSE_KEY'),
  };

  try {
    const response = await axios.post(url, body);
    dockerToken = response.data.docker_key;
    return response.data as {
      functions: { name: string; url: string }[];
      docker_key: string;
    };
  } catch (error) {
    console.error('Error fetching function list:', error.response.data);
    throw error;
  }
};

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
  const endpoint = new apigateway.RestAPI(
    `${functionPrefix}-dp-self-hosted`,
    {
      routes: [
        {
          path: '{route+}',
          method: 'ANY',
          eventHandler: managementFunction,
        },
      ],
      stageName: 'prod',
    },
    { dependsOn: [managementFunction] },
  );

  endpoint.url.apply((url) => {
    console.log('API Gateway endpoint URL:', url);
  });

  return endpoint;
};

export const initS3Bucket = async () => {
  if (existingS3Bucket) {
    s3BucketName = existingS3Bucket;
    return aws.s3.Bucket.get('existing-bucket', existingS3Bucket);
  } else {
    s3BucketName = `${functionPrefix}-assets`;
    return new aws.s3.Bucket(s3BucketName, {
      corsRules: [
        {
          allowedMethods: ['GET', 'PUT', 'POST', 'HEAD'],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          exposeHeaders: ['Content-Range'],
        },
      ],
    });
  }
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
    const resourceName = `${functionPrefix}-schedule-${idx}`;
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
export const initialLambdaFunctions = async (
  databaseUrl: pulumi.Output<string>,
  s3Bucket: Bucket,
) => {
  let managementFunction;
  let emailListenerFunction: aws.lambda.Function | undefined;
  const createdFunctions: aws.lambda.Function[] = [];

  let functionUrls: { name: string; url: string }[];
  try {
    functionUrls = (await fetchFunctionList()).functions;
  } catch (e) {
    throw new Error('Unauthorized: unable to retrieve the function list');
  }

  const mappingModuleUrl = await initialMappingModule(dockerToken, s3Bucket);

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
  // Enhanced EFS setup with proper mount target availability waiting
  // EFS Security Group (created before mount targets)
  const efsSg = new aws.ec2.SecurityGroup(`${functionPrefix}-efs-sg`, {
    vpcId: defaultVpc.id,
    description: 'EFS Security Group - Allow NFS traffic from Lambda functions',
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
        securityGroups: [lambdaSg.id], // Allow Lambda security group
      },
      {
        fromPort: 2049,
        toPort: 2049,
        protocol: 'tcp',
        cidrBlocks: [defaultVpc.apply((vpc) => vpc.cidrBlock)], // Allow VPC CIDR
      },
    ],
    tags: {
      Name: `${functionPrefix}-efs-security-group`,
      Application: 'pipelines-selfhost',
    },
  });

  const efs = new aws.efs.FileSystem(`${functionPrefix}-lambda-efs`, {
    creationToken: `${functionPrefix}-lambda-efs-token`,
    performanceMode: 'generalPurpose',
    throughputMode: 'provisioned',
    provisionedThroughputInMibps: 100,
    encrypted: true,
    tags: {
      Name: `${functionPrefix}-lambda-efs`,
      Application: 'pipelines-selfhost',
    },
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
    `${functionPrefix}-efs-wait`,
    {
      fileSystemId: efs.id,
      timeoutSeconds: 600,
      stabilizationSeconds: 120,
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

  // Additional wait after access point is created to ensure Lambda can use it
  const accessPointWaiter = new WaitForEfsTargets(
    `${functionPrefix}-access-point-wait`,
    {
      fileSystemId: efs.id,
      timeoutSeconds: 300,
      stabilizationSeconds: 60,
    },
    { dependsOn: [efsAccessPoint, waiter] },
  );
  // --------------------- End EFS Setup ---------------------

  // --------------------- SETUP IAM ROLE ---------------------
  const awsIamRole = new aws.iam.Role(`${functionPrefix}-self-hosted-role`, {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
      Service: 'lambda.amazonaws.com',
    }),
  });

  new aws.iam.RolePolicyAttachment(`${functionPrefix}-lambda-basic-exec`, {
    role: awsIamRole.name,
    policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
  });

  new aws.iam.RolePolicyAttachment(`${functionPrefix}-lambda-vpc-access`, {
    role: awsIamRole.name,
    policyArn: aws.iam.ManagedPolicy.AWSLambdaVPCAccessExecutionRole,
  });

  // Custom EFS policy for Lambda
  const lambdaEfsPolicy = new aws.iam.Policy(
    `${functionPrefix}-lambda-efs-specific-policy`,
    {
      description:
        'Allow Lambda to access only the specific EFS file system and access point',
      policy: pulumi
        .all([efs.arn, efsAccessPoint.arn])
        .apply(([efsArn, apArn]) =>
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
    },
  );
  new aws.iam.RolePolicyAttachment(
    `${functionPrefix}-lambda-efs-access-policy`,
    {
      role: awsIamRole.name,
      policyArn: lambdaEfsPolicy.arn,
    },
  );

  // Wait for all EFS-dependent resources to be ready before creating Lambda functions
  console.log(
    '🔄 Ensuring EFS is fully ready before creating Lambda functions...',
  );

  for (let i = 0; i < functionUrls.length; i++) {
    const loggingService = new aws.cloudwatch.LogGroup(
      `${functionPrefix}-${functionUrls[i].name}-log`,
      {
        name: `/aws/lambda/${functionPrefix}-${functionUrls[i].name}`,
      },
    );

    const functionName = `${functionPrefix}-${functionUrls[i].name}`;
    // Mount EFS only for specific functions that need shared storage
    const shouldMountEfs = [
      'management',
      'transform',
      'execute-fetch-input-data',
      'execute-transform',
      'fetch-input-data',
    ].includes(functionUrls[i].name);

    console.log(
      `📦 Creating Lambda function: ${functionName} (EFS: ${shouldMountEfs ? 'Yes' : 'No'})`,
    );
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
          logFormat: 'Text',
        },
        vpcConfig: {
          subnetIds: defaultSubnetIds.ids,
          securityGroupIds: [lambdaSg.id],
        },
        environment: {
          variables: {
            APP_STAGE: 'prod',
            DATA_PIPELINE_DB_URI: databaseUrl,
            DATA_PIPELINE_DB_NAME: config.require('DATA_PIPELINE_DB_NAME'),
            S3_CONNECTOR_SECRET_KEY: config.require('S3_CONNECTOR_SECRET_KEY'),
            AWS_PROVIDER_REGION: config.require('AWS_REGION'),
            AWS_PROVIDER_KEY: config.require('AWS_ACCESS_KEY'),
            AWS_PROVIDER_SECRET: config.require('AWS_SECRET_KEY'),
            AWS_S3_BUCKET: s3Bucket.bucket.apply((bucket) => bucket),
            PUSHER_APP_ID: config.get('PUSHER_APP_ID') || '',
            PUSHER_KEY: config.get('PUSHER_KEY') || '',
            PUSHER_SECRET: config.get('PUSHER_SECRET') || '',
            SERVERLESS_TRANSFORM_FUNCTION_NAME: `${functionPrefix}-transform`,
            SERVERLESS_EXECUTE_FETCH_INPUT_DATA_FUNCTION_NAME: `${functionPrefix}-execute-fetch-input-data`,
            SERVERLESS_EXECUTE_TRANSFORM_FUNCTION_NAME: `${functionPrefix}-execute-transform`,
            SERVERLESS_FETCH_INPUT_DATA_FUNCTION_NAME: `${functionPrefix}-fetch-input-data`,
            SERVERLESS_EXECUTE_WRITE_OUTPUT_DATA_FUNCTION_NAME: `${functionPrefix}-execute-write-output-data`,
            BREVO_API_KEY: config.get('BREVO_API_KEY') || '',
            MAPPING_BASE_URL: mappingModuleUrl,
            DP_LICENSE_KEY: config.require('INGESTRO_LICENSE_KEY'),
            CUSTOM_DOMAIN: config.get('customDomain') || '',
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
        dependsOn: shouldMountEfs
          ? [
              loggingService,
              s3Bucket,
              efsAccessPoint,
              waiter,
              accessPointWaiter,
            ]
          : [loggingService, s3Bucket],
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
    // Permission for S3 to invoke Lambda
    const s3Permission = new aws.lambda.Permission(
      `${functionPrefix}-email-listener-s3-permission`,
      {
        action: 'lambda:InvokeFunction',
        function: emailListenerFunction.name,
        principal: 's3.amazonaws.com',
        sourceArn: s3Bucket.arn,
      },
    );

    // S3 notification for object created
    new aws.s3.BucketNotification(
      `${functionPrefix}-email-listener-s3-notification`,
      {
        bucket: s3Bucket.id,
        lambdaFunctions: [
          {
            lambdaFunctionArn: emailListenerFunction.arn,
            events: ['s3:ObjectCreated:*'],
            filterPrefix: 'emails/',
          },
        ],
      },
      { dependsOn: [s3Permission] },
    );
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
