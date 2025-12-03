// Copyright 2016-2025, Pulumi Corporation.  All rights reserved.

import * as pulumi from '@pulumi/pulumi';
import * as resources from '@pulumi/azure-native/resources';
import * as storage from '@pulumi/azure-native/storage';
import * as web from '@pulumi/azure-native/web';
import * as network from '@pulumi/azure-native/network';
import * as insights from '@pulumi/azure-native/applicationinsights';
import * as operationalinsights from '@pulumi/azure-native/operationalinsights';
import * as cosmosdb from '@pulumi/azure-native/cosmosdb';
import * as random from '@pulumi/random';
import { getConnectionString, signedBlobReadUrl } from './helpers';
import { fetchFunctionList } from './utils/ingestro';
import { serializationConfigValue } from './utils/string';

let app: web.WebApp;
let appInsights: insights.Component;
let customDomain;
let customDomainDnsRecords;
let databaseConnectionString;

export const run = () => {
  const config = new pulumi.Config();
  const prefix = config.get('prefix') || 'ingestro';
  const existingResourceGroupName = `${prefix}-functions-rg`;
  const cosmosAccountName =
    config.get('COSMOS_ACCOUNT_NAME') || `${prefix}-mongo-ru-account`;
  const cosmosPrimaryRegion =
    config.get('COSMOS_PRIMARY_REGION') || 'germanywestcentral';
  const cosmosServerVersion =
    config.get('COSMOS_MONGO_SERVER_VERSION') || '5.0';
  const cosmosDatabaseName = config.get('COSMOS_DB_NAME') || 'ingestro';
  const cosmosLogDatabaseName =
    config.get('COSMOS_LOG_DB_NAME') || 'ingestro_logging';
  const cosmosDatabaseThroughput = config.getNumber('COSMOS_DB_RU') || 400;
  const cosmosLogDatabaseThroughput =
    config.getNumber('COSMOS_LOG_DB_RU') || cosmosDatabaseThroughput;
  const mappingContainerImage =
    config.require('MAPPING_CONTAINER_IMAGE') || 'getnuvo/mapping:latest';
  const mappingDockerServer =
    config.get('MAPPING_DOCKER_SERVER') || 'https://registry.hub.docker.com';
  const mappingAppName =
    config.get('MAPPING_APP_NAME') || `${prefix}-mapping-module`;
  const mappingModuleEnv =
    config.getObject<Record<string, string>>('MAPPING_MODULE_ENV') || {};
  const deploymentPayload = pulumi.output(fetchFunctionList());
  const resolvedCodeArtifact = deploymentPayload.apply((payload) => {
    const firstFunction = payload.functions?.[0];
    if (!firstFunction?.url || !firstFunction?.name) {
      throw new Error('API did not return a valid function payload');
    }
    return {
      blobName: `${firstFunction.name}.zip`,
      archive: new pulumi.asset.RemoteArchive(firstFunction.url),
      dockerKey: payload.docker_key || '',
    };
  });
  const mappingDockerPassword = resolvedCodeArtifact.apply(
    (artifact) => artifact.dockerKey,
  );
  const dataContainerSuffix = new random.RandomString(
    `${prefix}-data-container-suffix`,
    {
      length: 8,
      special: false,
      upper: false,
      lower: true,
      number: true,
    },
  );
  const dataContainerName = pulumi.interpolate`ingestrodata${dataContainerSuffix.result}`;

  // Create a separate resource group for this example.
  const resourceGroup = new resources.ResourceGroup(existingResourceGroupName, {
    location: 'germanywestcentral',
  });
  const location = resourceGroup.location;

  // ---------------- NETWORKING ----------------
  // VNet + subnet used for function and mapping app integration
  const logAnalytics = new operationalinsights.Workspace(
    `${prefix}-log-analytics`,
    {
      resourceGroupName: resourceGroup.name,
      location: location,
      sku: { name: 'PerGB2018' },
      retentionInDays: 30,
      features: {
        enableLogAccessUsingOnlyResourcePermissions: true,
      },
    },
  );

  appInsights = new insights.Component(`${prefix}-app-insights`, {
    resourceGroupName: resourceGroup.name,
    applicationType: insights.ApplicationType.Web,
    location: location,
    kind: 'web',
    workspaceResourceId: logAnalytics.id,
    ingestionMode: 'LogAnalytics',
  });

  const virtualNetwork = new network.VirtualNetwork(`${prefix}-function-vnet`, {
    resourceGroupName: resourceGroup.name,
    location: location,
    addressSpace: {
      addressPrefixes: ['10.2.0.0/16'], // A private address space for the VNet
    },
  });

  const subnetWithNat = new network.Subnet(`${prefix}-function-subnet`, {
    resourceGroupName: resourceGroup.name,
    virtualNetworkName: virtualNetwork.name,
    addressPrefix: '10.2.1.0/24',
    serviceEndpoints: [
      {
        service: 'Microsoft.Storage',
      },
      {
        service: 'Microsoft.AzureCosmosDB',
      },
    ],
    delegations: [
      {
        name: 'delegation',
        serviceName: 'Microsoft.Web/serverFarms',
      },
    ],
  });

  const cosmosAccount = new cosmosdb.DatabaseAccount(cosmosAccountName, {
    resourceGroupName: resourceGroup.name,
    location: cosmosPrimaryRegion,
    databaseAccountOfferType: 'Standard',
    kind: cosmosdb.DatabaseAccountKind.MongoDB,
    apiProperties: {
      serverVersion: cosmosServerVersion,
    },
    locations: [
      {
        locationName: cosmosPrimaryRegion,
        failoverPriority: 0,
        isZoneRedundant: false,
      },
    ],
    capabilities: [{ name: 'EnableMongo' }],
    consistencyPolicy: {
      defaultConsistencyLevel: cosmosdb.DefaultConsistencyLevel.Session,
    },
    publicNetworkAccess: 'Enabled',
    // Allow unrestricted public access; rely on auth instead of IP filtering
    tags: {
      environment: 'development',
      project: 'mongodb-ru',
    },
  });

  const cosmosDatabase = new cosmosdb.MongoDBResourceMongoDBDatabase(
    cosmosDatabaseName,
    {
      accountName: cosmosAccount.name,
      resourceGroupName: resourceGroup.name,
      resource: {
        id: cosmosDatabaseName,
      },
      options: {
        throughput: cosmosDatabaseThroughput,
      },
    },
    { dependsOn: [cosmosAccount] },
  );

  const cosmosLogDatabase = new cosmosdb.MongoDBResourceMongoDBDatabase(
    cosmosLogDatabaseName,
    {
      accountName: cosmosAccount.name,
      resourceGroupName: resourceGroup.name,
      resource: {
        id: cosmosLogDatabaseName,
      },
      options: {
        throughput: cosmosLogDatabaseThroughput,
      },
    },
    { dependsOn: [cosmosAccount] },
  );

  const accountConnectionStrings = pulumi
    .all([resourceGroup.name, cosmosAccount.name])
    .apply(([rgName, accountName]) =>
      cosmosdb.listDatabaseAccountConnectionStrings({
        resourceGroupName: rgName,
        accountName,
      }),
    );

  databaseConnectionString = accountConnectionStrings.apply((result) => {
    const primaryConnectionString =
      result.connectionStrings?.find((cs) =>
        cs.description?.includes('Primary MongoDB'),
      )?.connectionString || result.connectionStrings?.[0]?.connectionString;

    if (!primaryConnectionString) {
      throw new Error('Unable to resolve Cosmos DB Mongo connection string.');
    }

    return primaryConnectionString;
  });

  // Storage account is required by Function App.
  // Also, we will upload the function code to the same storage account.
  const storageAccount = new storage.StorageAccount(`${prefix}sa`, {
    resourceGroupName: resourceGroup.name,
    sku: {
      name: storage.SkuName.Standard_LRS,
    },
    kind: storage.Kind.StorageV2,
  });
  const getStorageAccountKeys = pulumi
    .all([resourceGroup.name, storageAccount.name])
    .apply(([rgName, accountName]) =>
      storage.listStorageAccountKeys({
        resourceGroupName: rgName,
        accountName: accountName,
      }),
    );

  // Function code archives will be stored in this container.
  const codeContainer = new storage.BlobContainer(`${prefix}-zips`, {
    resourceGroupName: resourceGroup.name,
    accountName: storageAccount.name,
  });

  const dataContainer = new storage.BlobContainer(`${prefix}-data-container`, {
    resourceGroupName: resourceGroup.name,
    accountName: storageAccount.name,
  });

  const fileShare = new storage.FileShare(`${prefix}-share-data`, {
    accountName: storageAccount.name,
    resourceGroupName: resourceGroup.name,
    shareName: `${prefix}-data-share`,
  });

  const codeBlobName = resolvedCodeArtifact.apply(
    (artifact) => artifact.blobName,
  );
  const codeSource = resolvedCodeArtifact.apply((artifact) => artifact.archive);

  const codeBlob = new storage.Blob(
    `${prefix}-function-code-blob`,
    {
      resourceGroupName: resourceGroup.name,
      accountName: storageAccount.name,
      containerName: codeContainer.name,
      blobName: codeBlobName,
      source: codeSource, // content ignored for updates unless codeVersion (and thus name) changes
    },
    {
      // Prevent unnecessary updates when codeVersion is unchanged (same name) even if the pre-signed URL changes
      ignoreChanges: ['source'],
    },
  );

  // Define a Consumption Plan for the Function App.
  // You can change the SKU to Premium or App Service Plan if needed.
  const plan = new web.AppServicePlan(`${prefix}-plan`, {
    resourceGroupName: resourceGroup.name,
    location: resourceGroup.location,
    sku: {
      name: 'EP1',
      tier: 'ElasticPremium',
    },
    kind: 'functionapp,linux',
    reserved: true,
  });

  const mappingPlan = new web.AppServicePlan(`${prefix}-mapping-plan`, {
    resourceGroupName: resourceGroup.name,
    location: resourceGroup.location,
    sku: {
      name: 'P1v3',
      tier: 'PremiumV3',
      capacity: 1,
    },
    kind: 'app,linux',
    reserved: true,
  });

  // Build the connection string and zip archive's SAS URL. They will go to Function App's settings.
  const storageConnectionString = getConnectionString(
    resourceGroup.name,
    storageAccount.name,
  );
  const codeBlobUrl = signedBlobReadUrl(
    codeBlob,
    codeContainer,
    storageAccount,
    resourceGroup,
  );

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
  const mappingS3Region = config.require('AWS_REGION') || '';
  const mappingS3AccessKeyId = config.require('AWS_ACCESS_KEY') || '';
  const mappingS3SecretAccessKey = config.require('AWS_SECRET_KEY') || '';
  const mappingBucketNamePipeline = config.get('AWS_S3_BUCKET') || '';

  const mappingAppSettings = [
    { name: 'WEBSITES_PORT', value: '8000' },
    { name: 'DOCKER_REGISTRY_SERVER_URL', value: mappingDockerServer },
    {
      name: 'DOCKER_REGISTRY_SERVER_USERNAME',
      value: 'getnuvo',
    },
    {
      name: 'DOCKER_REGISTRY_SERVER_PASSWORD',
      value: mappingDockerPassword,
    },
    { name: 'DOCKER_CUSTOM_IMAGE_NAME', value: mappingContainerImage },
    {
      name: 'APPINSIGHTS_INSTRUMENTATIONKEY',
      value: appInsights.instrumentationKey,
    },
    {
      name: 'APPLICATIONINSIGHTS_CONNECTION_STRING',
      value: appInsights.connectionString,
    },
    {
      name: 'NODE_ENV',
      value: 'production',
    },
    {
      name: 'MAPPING_PORT',
      value: '8000',
    },
    {
      name: 'MAPPING_LLM_PROVIDER',
      value: serializationConfigValue(mappingLlmProvider),
    },
    {
      name: 'MAPPING_LLM_TEMPERATURE',
      value: serializationConfigValue(mappingLlmTemperature),
    },
    {
      name: 'MAPPING_AZURE_OPENAI_API_KEY',
      value: serializationConfigValue(mappingAzureOpenaiApiKey),
    },
    {
      name: 'MAPPING_AZURE_OPENAI_ENDPOINT',
      value: serializationConfigValue(mappingAzureOpenaiEndpoint),
    },
    {
      name: 'MAPPING_AZURE_OPENAI_API_VERSION',
      value: serializationConfigValue(mappingAzureOpenaiApiVersion),
    },
    {
      name: 'MAPPING_AZURE_OPENAI_DEPLOYMENT_NAME',
      value: serializationConfigValue(mappingAzureOpenaiDeploymentName),
    },
    {
      name: 'MAPPING_AWS_BEDROCK_MODEL_ID',
      value: serializationConfigValue(mappingAwsBedrockModelId),
    },
    {
      name: 'MAPPING_AWS_BEDROCK_ACCESS_KEY_ID',
      value: serializationConfigValue(mappingAwsBedrockAccessKeyId),
    },
    {
      name: 'MAPPING_AWS_BEDROCK_SECRET_ACCESS_KEY',
      value: serializationConfigValue(mappingAwsBedrockSecretAccessKey),
    },
    {
      name: 'MAPPING_AWS_BEDROCK_REGION',
      value: serializationConfigValue(mappingAwsBedrockRegion),
    },
    {
      name: 'MAPPING_S3_REGION',
      value: serializationConfigValue(mappingS3Region),
    },
    {
      name: 'MAPPING_S3_ACCESS_KEY_ID',
      value: serializationConfigValue(mappingS3AccessKeyId),
    },
    {
      name: 'MAPPING_S3_SECRET_ACCESS_KEY',
      value: serializationConfigValue(mappingS3SecretAccessKey),
    },
    {
      name: 'MAPPING_BUCKET_NAME_PIPELINE',
      value: serializationConfigValue(mappingBucketNamePipeline),
    },
    // TODO: add AZURE BLOB STORAGE SETTINGS
    ...Object.entries(mappingModuleEnv).map(([name, value]) => ({
      name,
      value,
    })),
  ];

  const mappingApp = new web.WebApp(mappingAppName, {
    resourceGroupName: resourceGroup.name,
    serverFarmId: mappingPlan.id,
    kind: 'app,linux',
    reserved: true,
    siteConfig: {
      linuxFxVersion: pulumi.interpolate`DOCKER|${mappingContainerImage}`,
      appSettings: mappingAppSettings,
      alwaysOn: true,
      http20Enabled: true,
      use32BitWorkerProcess: false,
    },
    httpsOnly: true,
  });

  const mappingAppVnetIntegration = new web.WebAppSwiftVirtualNetworkConnection(
    `${prefix}-mapping-app-vnet-integration`,
    {
      name: mappingApp.name,
      resourceGroupName: resourceGroup.name,
      subnetResourceId: subnetWithNat.id,
    },
    { dependsOn: [mappingApp, subnetWithNat] },
  );

  const mappingBaseUrl = mappingApp.defaultHostName.apply(
    (host) => `https://${host}`,
  );

  const sharedMountConfig = {
    'transformation-mount': {
      // A friendly name for the mount configuration
      type: web.AzureStorageType.AzureFiles,
      accountName: storageAccount.name,
      shareName: fileShare.name,
      accessKey: getStorageAccountKeys.keys[0].value,
      mountPath: '/mnt/hyperformula-column',
    },
  };
  const functionAppName = `${prefix}-dp-self-hosted`;
  const baseAppEnvironmentVariables = [
    { name: 'AzureWebJobsStorage', value: storageConnectionString },
    { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' },
    { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' },
    { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' },
    { name: 'WEBSITE_RUN_FROM_PACKAGE', value: codeBlobUrl },
    {
      name: 'WEBSITE_CONTENTAZUREFILECONNECTIONSTRING',
      value: storageConnectionString,
    },
    {
      name: 'WEBSITE_CONTENTSHARE',
      value: `${functionAppName}-contentshare`,
    },
    { name: 'WEBSITE_VNET_ROUTE_ALL', value: '1' },
    // Application Insights settings
    {
      name: 'APPINSIGHTS_INSTRUMENTATIONKEY',
      value: appInsights.instrumentationKey,
    },
    {
      name: 'APPLICATIONINSIGHTS_CONNECTION_STRING',
      value: appInsights.connectionString,
    },
    { name: 'ApplicationInsightsAgent_EXTENSION_VERSION', value: '~3' },
    { name: 'XDT_MicrosoftApplicationInsights_Mode', value: 'recommended' },
  ];
  app = new web.WebApp(functionAppName, {
    resourceGroupName: resourceGroup.name,
    serverFarmId: plan.id,
    kind: 'functionapp,linux',
    reserved: true,
    siteConfig: {
      appSettings: baseAppEnvironmentVariables,
      http20Enabled: true,
      nodeVersion: '~20',
      linuxFxVersion: 'NODE|20',
      azureStorageAccounts: sharedMountConfig,
    },
    httpsOnly: true,
  });

  const functionAppUrl = app.defaultHostName.apply((host) => {
    const url = `https://${host}`;
    console.log('Azure Function App URL:', url);
    return url;
  });

  // VNet integration (unchanged)
  const functionVnetIntegration = new web.WebAppSwiftVirtualNetworkConnection(
    `${prefix}-management-func-vnet-integration`,
    {
      name: app.name,
      resourceGroupName: resourceGroup.name,
      subnetResourceId: subnetWithNat.id,
    },
    { dependsOn: [subnetWithNat] },
  );

  // ---------------- CUSTOM DOMAIN + OPTIONAL SSL ----------------
  // Optional custom domain config
  const customDomain = config.get('customDomain');
  if (customDomain) {
    pulumi
      .all([customDomain, app.defaultHostName, app.customDomainVerificationId])
      .apply(([domain, defaultHost, verificationId]) => {
        const labels = domain.split('.');
        const isSubdomain = labels.length > 2;
        const txtRelative = isSubdomain ? `asuid.${labels[0]}` : 'asuid';
        const hostRelative = isSubdomain
          ? labels.slice(0, labels.length - 2).join('.')
          : '@';

        console.log('\n' + '='.repeat(80));
        console.log('🌐 CUSTOM DOMAIN SETUP REQUIRED');
        console.log('='.repeat(80));
        console.log(
          '\n⚠️  IMPORTANT: Create these DNS records BEFORE the binding is applied:\n',
        );
        console.log(`📋 Domain: ${domain}`);
        console.log(`🔗 Target: ${defaultHost}\n`);
        console.log('Required DNS Records:');
        console.log('-'.repeat(80));
        console.log(
          `\n1️⃣  TXT Record (Domain Verification - REQUIRED FIRST)`,
        );
        console.log(`   Name:  ${txtRelative}`);
        console.log(`   Value: ${verificationId}`);
        console.log(`   TTL:   3600\n`);

        if (isSubdomain) {
          console.log(`2️⃣  CNAME Record (Domain Mapping)`);
          console.log(`   Name:  ${hostRelative}`);
          console.log(`   Value: ${defaultHost}`);
          console.log(`   TTL:   3600\n`);
        } else {
          console.log(`2️⃣  ALIAS/ANAME Record (Domain Mapping)`);
          console.log(`   Name:  @`);
          console.log(`   Value: ${defaultHost}`);
          console.log(`   TTL:   3600`);
          console.log(
            `   Note:  If your DNS provider doesn't support ALIAS/ANAME,`,
          );
          console.log(`          consider using a subdomain with CNAME instead\n`);
        }

        console.log('-'.repeat(80));
        console.log('\n✅ Action Required:');
        console.log('   1. Go to your DNS provider (e.g., Cloudflare, Route53)');
        console.log('   2. Add the DNS records listed above');
        console.log('   3. Wait 5-10 minutes for DNS propagation');
        console.log('   4. Run `pulumi up` again to create the binding\n');
        console.log('='.repeat(80) + '\n');
      });

    new web.WebAppHostNameBinding(
      `${prefix}-custom-domain-binding`,
      {
        name: app.name,
        siteName: app.name,
        hostName: customDomain,
        resourceGroupName: resourceGroup.name,
      },
      { dependsOn: [app] },
    );
  }

  // ---------------- APPLICATION SETTINGS ----------------
  const appSettings = [
    ...baseAppEnvironmentVariables,
    {
      name: 'DATA_PIPELINE_DB_URI',
      value: databaseConnectionString,
    },
    {
      name: 'DATA_PIPELINE_DB_NAME',
      value: cosmosDatabaseName,
    },
    {
      name: 'DATA_PIPELINE_LOG_DB_NAME',
      value: cosmosLogDatabaseName,
    },
    {
      name: 'S3_CONNECTOR_SECRET_KEY',
      value: config.require('S3_CONNECTOR_SECRET_KEY'),
    },
    { name: 'MAPPING_BASE_URL', value: mappingBaseUrl },
    {
      name: 'CLOUD_PROVIDER',
      value: 'AZURE',
    },
    {
      name: 'AZURE_STORAGE_CONTAINER_NAME',
      value: dataContainer.name.apply((name) => name),
    },
    { name: 'AZURE_ACCOUNT_NAME', value: storageAccount.name },
    {
      name: 'AZURE_CONNECTION_STRING',
      value: storageConnectionString,
    },
    { name: 'PUSHER_APP_ID', value: config.get('PUSHER_APP_ID') },
    { name: 'PUSHER_KEY', value: config.get('PUSHER_KEY') },
    { name: 'PUSHER_SECRET', value: config.get('PUSHER_SECRET') },
    { name: 'BREVO_API_KEY', value: config.get('BREVO_API_KEY') },
    { name: 'DP_LICENSE_KEY', value: config.require('INGESTRO_LICENSE_KEY') },
    {
      name: 'AZURE_FUNCTION_BASE_URL',
      value: functionAppUrl,
    },
    // TODO: remove AWS settings
    {
      name: 'STORAGE_PROVIDER_ENVIRONMENT',
      value: 'AWS',
    },
    {
      name: 'AWS_PROVIDER_REGION',
      value: config.require('AWS_REGION'),
    },
    {
      name: 'AWS_PROVIDER_KEY',
      value: config.require('AWS_ACCESS_KEY'),
    },
    {
      name: 'AWS_PROVIDER_SECRET',
      value: config.require('AWS_SECRET_KEY'),
    },
    {
      name: 'AWS_S3_BUCKET',
      value: config.require('AWS_S3_BUCKET'),
    },
    // Optionally surface custom domain into app env (not required for binding)
    ...(customDomain ? [{ name: 'CUSTOM_DOMAIN', value: customDomain }] : []),
  ];

  const appSettingsResource = new web.WebAppApplicationSettings(
    `${prefix}-app-settings`,
    {
      name: app.name,
      resourceGroupName: resourceGroup.name,
      properties: pulumi.output(appSettings).apply((settings) => {
        const result: { [k: string]: string } = {};
        settings.forEach((s) => {
          result[s.name] = s.value || '';
        });
        return result;
      }),
    },
  );

  // Build structured DNS record data for custom domain verification + mapping
  customDomainDnsRecords = customDomain
    ? pulumi
        .all([
          customDomain,
          app.defaultHostName,
          app.customDomainVerificationId,
        ])
        .apply(([domain, defaultHost, verificationId]) => {
          const labels = domain.split('.');
          const isSubdomain = labels.length > 2; // simplistic (doesn't handle multi-part TLDs like .co.uk)
          const hostRelative = isSubdomain
            ? labels.slice(0, labels.length - 2).join('.')
            : '@';
          const txtRelative = isSubdomain ? `asuid.${labels[0]}` : 'asuid';
          const records: any[] = [
            {
              type: 'TXT',
              name: txtRelative,
              values: [verificationId],
              ttl: 3600,
              description:
                'Azure App Service domain verification record (must exist before binding).',
            },
          ];
          if (isSubdomain) {
            records.push({
              type: 'CNAME',
              name: hostRelative,
              value: defaultHost,
              ttl: 3600,
              description: 'Map subdomain to Function App default host name',
            });
          } else {
            // For apex domains, prefer ALIAS/ANAME records pointing to the default host instead of mapping to transient outbound IPs.
            records.push({
              type: 'ALIAS',
              name: '@',
              value: defaultHost,
              ttl: 3600,
              description:
                'Use ALIAS/ANAME (if registrar supports) pointing to the default host. If unsupported, consider using a subdomain CNAME or introducing Azure Front Door / Traffic Manager for apex support.',
            });
          }
          return records;
        })
    : undefined;

  return {
    endpoint: functionAppUrl.apply((url) => `${url}/dp`),
    appInsightsInstrumentationKey: appInsights.instrumentationKey,
    appInsightsConnectionString: appInsights.connectionString,
    configuredCustomDomain: customDomain || undefined,
    customDomainDnsRecordsExport: customDomainDnsRecords,
    databaseConnectionStringExport: databaseConnectionString,
    mappingModuleUrl: mappingBaseUrl,
  };
};
