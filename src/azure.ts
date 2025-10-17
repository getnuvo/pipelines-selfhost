// Copyright 2016-2025, Pulumi Corporation.  All rights reserved.

import * as pulumi from '@pulumi/pulumi';
import * as resources from '@pulumi/azure-native/resources';
import * as storage from '@pulumi/azure-native/storage';
import * as web from '@pulumi/azure-native/web';
import * as network from '@pulumi/azure-native/network';
import axios from 'axios';
import * as insights from '@pulumi/azure-native/applicationinsights';
import * as operationalinsights from '@pulumi/azure-native/operationalinsights';
import * as cosmosdb from '@pulumi/azure-native/cosmosdb';
import { getConnectionString, signedBlobReadUrl } from './helpers';

let app: web.WebApp;
let appInsights: insights.Component;
let customDomain;
let customDomainDnsRecords;
let databaseConnectionString;
let staticIpAddress;

export const run = () => {
  const config = new pulumi.Config();
  const existingResourceGroupName = 'functions-rg';

  // Create a separate resource group for this example.
  const resourceGroup = new resources.ResourceGroup(existingResourceGroupName, {
    location: 'germanywestcentral',
  });
  const location = resourceGroup.location;

  const vcoreAdminUser = config.require('VC_MONGO_ADMIN_USERNAME');
  const vcoreAdminPassword = config.require('VC_MONGO_ADMIN_PASSWORD');
  const mongoClusterName =
    config.get('MONGO_CLUSTER_NAME') || 'mongo-vcore-cluster';
  const mongoCluster = new cosmosdb.MongoCluster(mongoClusterName, {
    resourceGroupName: resourceGroup.name,
    location: 'germanynorth',
    administratorLogin: vcoreAdminUser,
    administratorLoginPassword: vcoreAdminPassword,
    serverVersion: '5.0',

    // Define the cluster tier (SKU), storage, and number of nodes.
    // M30 is a good starting point for development/testing.
    nodeGroupSpecs: [
      {
        sku: 'M30',
        diskSizeGB: 128,
        enableHa: true, // High availability
        kind: 'Shard',
        nodeCount: 2,
      },
    ],

    tags: {
      environment: 'development',
      project: 'mongodb-vcore-demo',
    },
  });

  databaseConnectionString = mongoCluster.connectionString.apply(
    (connectionString) =>
      connectionString
        .replace('<user>', vcoreAdminUser)
        .replace('<password>', encodeURIComponent(vcoreAdminPassword)),
  );

  // ---------------- NETWORKING ----------------
  // NAT gateway + public IP for outbound traffic
  const logAnalytics = new operationalinsights.Workspace('log-analytics', {
    resourceGroupName: resourceGroup.name,
    location: location,
    sku: { name: 'PerGB2018' },
    retentionInDays: 30,
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true,
    },
  });

  appInsights = new insights.Component('appinsights', {
    resourceGroupName: resourceGroup.name,
    applicationType: insights.ApplicationType.Web,
    location: location,
    kind: 'web',
    workspaceResourceId: logAnalytics.id,
    ingestionMode: 'LogAnalytics',
  });

  const publicIp = new network.PublicIPAddress('nat-public-ip', {
    resourceGroupName: resourceGroup.name,
    location: location,
    sku: {
      name: network.PublicIPAddressSkuName.Standard,
    },
    publicIPAllocationMethod: network.IPAllocationMethod.Static,
  });

  const natGateway = new network.NatGateway('function-nat-gateway', {
    resourceGroupName: resourceGroup.name,
    location: location,
    sku: {
      name: network.NatGatewaySkuName.Standard,
    },
    publicIpAddresses: [
      {
        id: publicIp.id,
      },
    ],
  });

  const virtualNetwork = new network.VirtualNetwork('function-vnet', {
    resourceGroupName: resourceGroup.name,
    location: location,
    addressSpace: {
      addressPrefixes: ['10.2.0.0/16'], // A private address space for the VNet
    },
  });

  const subnetWithNat = new network.Subnet(
    'function-subnet',
    {
      resourceGroupName: resourceGroup.name,
      virtualNetworkName: virtualNetwork.name,
      addressPrefix: '10.2.1.0/24', // A subnet within the VNet's address space
      natGateway: {
        id: natGateway.id,
      },
      // Add a service endpoint for Azure Storage to allow reliable access from the VNet
      serviceEndpoints: [
        {
          service: 'Microsoft.Storage',
        },
      ],
      // Required delegation for VNet integration with Azure Functions
      delegations: [
        {
          name: 'delegation',
          serviceName: 'Microsoft.Web/serverFarms',
        },
      ],
    },
    { dependsOn: [natGateway] },
  );

  const mongoClusterFirewallRuleIngestro =
    new cosmosdb.MongoClusterFirewallRule('mongoClusterFirewallRule-ingestro', {
      endIpAddress: '3.76.77.133',
      firewallRuleName: 'ingestro-vpn',
      mongoClusterName: mongoCluster.name,
      resourceGroupName: resourceGroup.name,
      startIpAddress: '3.76.77.133',
    });
  staticIpAddress = publicIp.ipAddress.apply((ip) => ip || '');
  const mongoClusterFirewallRuleFunction =
    new cosmosdb.MongoClusterFirewallRule('mongoClusterFirewallRule-function', {
      endIpAddress: staticIpAddress,
      firewallRuleName: 'function',
      mongoClusterName: mongoCluster.name,
      resourceGroupName: resourceGroup.name,
      startIpAddress: staticIpAddress,
    });

  // Storage account is required by Function App.
  // Also, we will upload the function code to the same storage account.
  const storageAccount = new storage.StorageAccount('sa', {
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
  const codeContainer = new storage.BlobContainer('zips', {
    resourceGroupName: resourceGroup.name,
    accountName: storageAccount.name,
  });

  const fileShare = new storage.FileShare('fileshare-data', {
    accountName: storageAccount.name,
    resourceGroupName: resourceGroup.name,
    shareName: 'my-data-share',
  });

  const codeVersion = config.get('codeVersion') || '0.0.0';
  const skipUrlValidation =
    (config.get('skipUrlValidation') || '').toLowerCase() === 'true';
  const getSourceCodeRemoteUrl = async () => {
    const apiUrl =
      'http://demo8472884.mockable.io/dp-self-hosted?version=' + codeVersion;
    let sourceCodeUrl: string;

    try {
      console.log(`Making an API call to ${apiUrl}...`);
      const response = await axios.get(apiUrl, { timeout: 10000 });
      const urlField = response.data.url;
      if (typeof urlField !== 'string' || !urlField) {
        throw new Error('API did not return a valid url field');
      }
      sourceCodeUrl = urlField;
      console.log(`Retrieved source code URL: ${sourceCodeUrl}`);
    } catch (error) {
      console.error('Failed to retrieve source code URL from API:', error);
      throw error; // propagate original error for better diagnostics
    }

    if (!skipUrlValidation) {
      try {
        console.log('Validating pre-signed URL (HEAD)...');
        await axios.head(sourceCodeUrl, { timeout: 10000 });
        console.log('HEAD validation succeeded.');
      } catch (headErr) {
        console.warn(
          'HEAD validation failed, attempting ranged GET (first byte)...',
        );
        try {
          await axios.get(sourceCodeUrl, {
            timeout: 15000,
            headers: { Range: 'bytes=0-0' },
            responseType: 'arraybuffer',
          });
          console.log('Ranged GET validation succeeded.');
        } catch (getErr) {
          console.error('Pre-signed URL validation failed:', getErr);
          throw new Error('Pre-signed URL not accessible; aborting deploy.');
        }
      }
    } else {
      console.log(
        'Skipping pre-signed URL validation due to skipUrlValidation=true',
      );
    }

    return sourceCodeUrl;
  };

  const sourceCodeRemoteUrl = getSourceCodeRemoteUrl();
  const codeSource = new pulumi.asset.RemoteArchive(sourceCodeRemoteUrl);
  const codeBlobName = `azure-${codeVersion}.zip`;

  const codeBlob = new storage.Blob(
    codeBlobName,
    {
      resourceGroupName: resourceGroup.name,
      accountName: storageAccount.name,
      containerName: codeContainer.name,
      source: codeSource, // content ignored for updates unless codeVersion (and thus name) changes
    },
    {
      // Prevent unnecessary updates when codeVersion is unchanged (same name) even if the pre-signed URL changes
      ignoreChanges: ['source'],
    },
  );

  // Define a Consumption Plan for the Function App.
  // You can change the SKU to Premium or App Service Plan if needed.
  const plan = new web.AppServicePlan('plan', {
    resourceGroupName: resourceGroup.name,
    location: resourceGroup.location,
    sku: {
      name: 'EP1',
      tier: 'ElasticPremium',
    },
    kind: 'functionapp,linux',
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
  const functionAppName = 'dp-self-hosted';
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

  // VNet integration (unchanged)
  const functionVnetIntegration = new web.WebAppSwiftVirtualNetworkConnection(
    'managementFuncVnetIntegration',
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
  let customDomainBinding: web.WebAppHostNameBinding | undefined;

  if (customDomain) {
    // 1. Create basic host name binding (no SSL yet). Azure requires TXT verification + DNS mapping ready.
    customDomainBinding = new web.WebAppHostNameBinding(
      'custom-domain-binding',
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
      name: 'USER_PLATFORM_DB_NAME',
      value: config.require('USER_PLATFORM_DB_NAME'),
    },
    {
      name: 'USER_PLATFORM_DB_HOST',
      value: config.require('USER_PLATFORM_DB_HOST'),
    },
    {
      name: 'USER_PLATFORM_DB_USERNAME',
      value: config.require('USER_PLATFORM_DB_USERNAME'),
    },
    {
      name: 'USER_PLATFORM_DB_PASSWORD',
      value: config.require('USER_PLATFORM_DB_PASSWORD'),
    },
    {
      name: 'DATA_PIPELINE_DB_NAME',
      value: config.require('DATA_PIPELINE_DB_NAME'),
    },
    {
      name: 'DATA_PIPELINE_DB_URI',
      value: databaseConnectionString,
    },
    {
      name: 'DATA_PIPELINE_LOG_DB_NAME',
      value: config.require('DATA_PIPELINE_LOG_DB_NAME'),
    },
    {
      name: 'USER_PLATFORM_LOG_DB_NAME',
      value: config.require('USER_PLATFORM_LOG_DB_NAME'),
    },
    { name: 'JWT_SECRET_KEY', value: config.require('JWT_SECRET_KEY') },
    {
      name: 'S3_CONNECTOR_SECRET_KEY',
      value: config.require('S3_CONNECTOR_SECRET_KEY'),
    },
    {
      name: 'HYPERFORMULA_LICENSE_KEY',
      value: config.require('HYPERFORMULA_LICENSE_KEY'),
    },
    { name: 'PUSHER_APP_ID', value: config.require('PUSHER_APP_ID') },
    { name: 'PUSHER_KEY', value: config.require('PUSHER_KEY') },
    { name: 'PUSHER_SECRET', value: config.require('PUSHER_SECRET') },
    { name: 'BREVO_API_KEY', value: config.require('BREVO_API_KEY') },
    { name: 'MAPPING_BASE_URL', value: config.require('MAPPING_BASE_URL') },
    {
      name: 'CLOUD_PROVIDER_ENVIRONMENT',
      value: config.require('CLOUD_PROVIDER_ENVIRONMENT'),
    },
    { name: 'STORAGE_PROVIDER', value: config.require('STORAGE_PROVIDER') },
    {
      name: 'AZURE_STORAGE_CONTAINER_NAME',
      value: config.require('AZURE_STORAGE_CONTAINER_NAME'),
    },
    { name: 'AZURE_ACCOUNT_NAME', value: config.require('AZURE_ACCOUNT_NAME') },
    {
      name: 'AZURE_CONNECTION_STRING',
      value: config.require('AZURE_CONNECTION_STRING'),
    },
    {
      name: 'AZURE_FUNCTION_BASE_URL',
      value: app.defaultHostName.apply((h) => `https://${h}`),
    },
    // Optionally surface custom domain into app env (not required for binding)
    ...(customDomain ? [{ name: 'CUSTOM_DOMAIN', value: customDomain }] : []),
  ];

  const appSettingsResource = new web.WebAppApplicationSettings(
    'app-settings',
    {
      name: app.name,
      resourceGroupName: resourceGroup.name,
      properties: pulumi.output(appSettings).apply((settings) => {
        const result: { [k: string]: string } = {};
        settings.forEach((s) => {
          result[s.name] = s.value;
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
            // For apex domains, avoid using the NAT gateway public IP (outbound only). Recommend ALIAS/ANAME where supported.
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
    ndpoint: pulumi.interpolate`https://${app.defaultHostName}/dp`,
    appInsightsInstrumentationKey: appInsights.instrumentationKey,
    appInsightsConnectionString: appInsights.connectionString,
    configuredCustomDomain: customDomain || undefined,
    customDomainDnsRecordsExport: customDomainDnsRecords,
    databaseConnectionStringExport: databaseConnectionString,
  };
};
