// Ingestro DP self-hosted on Azure, private network only.
// The spoke (VNet, compute, Storage, Key Vault, Private Endpoints) is created here; the hub
// (Azure Firewall, App Gateway, Private DNS zones, peering) belongs to the customer and is
// passed in as config.
//
// computeMode:
//   functionapp (default)  DP on a Function App (Linux custom container) + the mapping module on a
//                          Web App, both reachable only through Private Endpoints
//   vm                     DP + mapping with docker compose on one Linux VM

import * as fs from 'fs';
import * as path from 'path';
import * as pulumi from '@pulumi/pulumi';
import * as authorization from '@pulumi/azure-native/authorization';
import * as compute from '@pulumi/azure-native/compute';
import * as keyvault from '@pulumi/azure-native/keyvault';
import { Provider as AzureNativeProvider } from '@pulumi/azure-native/provider';
import * as monitor from '@pulumi/azure-native/monitor';
import * as network from '@pulumi/azure-native/network';
import * as operationalinsights from '@pulumi/azure-native/operationalinsights';
import * as privatedns from '@pulumi/azure-native/privatedns';
import * as resources from '@pulumi/azure-native/resources';
import * as storage from '@pulumi/azure-native/storage';
import * as web from '@pulumi/azure-native/web';
import * as random from '@pulumi/random';
import { getConnectionString } from './helpers';
import { fetchFunctionList } from './utils/ingestro';

const ROLE_KEY_VAULT_SECRETS_USER = '4633458b-17de-408a-b874-0445c86b69e6';
const ROLE_ACR_PULL = '7f951dff-4bc7-4b4a-8ab8-1bf7a36cdeb6';
const DP_API_PORT = 8080;
const HEALTH_PROBE_PATH = '/dp/api/v1/management/health';
const HYPERFORMULA_MOUNT_PATH = '/mnt/hyperformula-column';

type ComputeMode = 'functionapp' | 'vm';

// Private DNS zones each mode needs (keys of the privateDnsZoneIds config).
const REQUIRED_ZONES: Record<ComputeMode, string[]> = {
  vm: ['blob', 'vault'],
  // file/queue/table: Function App storage (AzureWebJobsStorage + HyperFormula share)
  // sites: privatelink.azurewebsites.net for the Function App / Web App endpoints
  functionapp: ['blob', 'file', 'queue', 'table', 'vault', 'sites'],
};

const readFile = (relativePath: string) =>
  fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

const toBase64 = (value: string) => Buffer.from(value).toString('base64');

const envLines = (entries: Record<string, string | undefined>) =>
  Object.entries(entries)
    .filter(([, value]) => value !== undefined && value !== '')
    // Compose interpolates `$` in env files; `$$` is a literal `$`.
    .map(
      ([name, value]) => `${name}=${(value as string).replace(/\$/g, '$$$$')}`,
    )
    .join('\n') + '\n';

// Key Vault secret names allow only [0-9a-zA-Z-].
const secretName = (envName: string) =>
  envName.toLowerCase().replace(/_/g, '-');

const withoutEmpty = (entries: Record<string, string | undefined>) =>
  Object.fromEntries(
    Object.entries(entries).filter(
      ([, value]) => value !== undefined && value !== '',
    ),
  ) as Record<string, string>;

export const run = () => {
  const config = new pulumi.Config();

  // ---------------- CONFIG ----------------
  const prefix = config.get('prefix') || 'ingestro';
  const environment = config.require('environment');
  const location = config.get('location') || 'germanywestcentral';
  const name = (suffix: string) => `${prefix}-${environment}-${suffix}`;

  const computeMode = (config.get('computeMode') ||
    'functionapp') as ComputeMode;
  if (!(computeMode in REQUIRED_ZONES)) {
    throw new Error('computeMode must be "functionapp" or "vm".');
  }

  // Azure appends an 8 character suffix; storage accounts and vaults allow 24 characters.
  const storageAccountName = `${prefix}${environment}sa`
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const keyVaultName = name('kv');
  if (storageAccountName.length > 16 || keyVaultName.length > 16) {
    throw new Error(
      `prefix + environment is too long for Azure names ("${storageAccountName}", "${keyVaultName}" must be <= 16 characters). Use a shorter prefix or environment.`,
    );
  }

  const dpVersion = config.require('version');
  const mappingVersion = config.get('mappingVersion') || 'latest';
  const acrLoginServer = config.get('acrLoginServer');
  const acrId = config.get('acrId');
  if (!!acrLoginServer !== !!acrId) {
    throw new Error('Set both acrLoginServer and acrId, or neither.');
  }
  const registryServer = acrLoginServer || 'registry-1.docker.io';
  const imageRepo = acrLoginServer ? `${acrLoginServer}/ingestro` : 'ingestro';
  // The Function App runs the Azure Functions host build of the same release.
  const dpImage =
    computeMode === 'functionapp'
      ? `${imageRepo}/pipelines:${dpVersion}-functions`
      : `${imageRepo}/pipelines:${dpVersion}`;
  const mappingImage = `${imageRepo}/mapping:${mappingVersion}`;

  const spokeAddressSpace = config.require('spokeAddressSpace');
  const peSubnetPrefix = config.require('peSubnetPrefix');
  const firewallPrivateIp = config.require('firewallPrivateIp');
  const appGatewaySubnetCidr = config.require('appGatewaySubnetCidr');
  const dnsServers = config.getObject<string[]>('dnsServers');
  const privateDnsZoneIds =
    config.requireObject<Record<string, string>>('privateDnsZoneIds');
  const missingZones = REQUIRED_ZONES[computeMode].filter(
    (zone) => !privateDnsZoneIds[zone],
  );
  if (missingZones.length > 0) {
    throw new Error(
      `privateDnsZoneIds is missing ${missingZones.join(', ')} (computeMode ${computeMode} needs ${REQUIRED_ZONES[computeMode].join(', ')}).`,
    );
  }
  // Link the zones to the spoke when there is no hub DNS proxy resolving them for us.
  const linkPrivateDnsZonesToSpoke =
    config.getBoolean('linkPrivateDnsZonesToSpoke') ?? false;

  const licenseKey = config.requireSecret('INGESTRO_LICENSE_KEY');
  const mongoConnectionString = config.requireSecret('MONGO_CONNECTION_STRING');
  const atlasPrivateLinkServiceId = config.get('ATLAS_PRIVATE_LINK_SERVICE_ID');
  const dbName = config.get('DB_NAME') || 'ingestro';
  const logDbName = config.get('LOG_DB_NAME') || 'ingestro_logging';
  const allowedOrigins = config.requireObject<string[]>('allowedOrigins');
  // Browser SAS URLs through a proxy origin (App Gateway path rule), e.g. https://ingestro.company.local/blob
  const blobPublicBaseUrl = config.get('blobPublicBaseUrl');

  // May hold credentials, so it is read and passed on as a secret.
  const mappingModuleEnv =
    config.getSecretObject<Record<string, string>>('MAPPING_MODULE_ENV') ??
    pulumi.output({} as Record<string, string>);

  // Only Docker Hub pulls need the registry key from the self-host deployment API.
  const dockerKey = acrLoginServer
    ? undefined
    : pulumi.output(fetchFunctionList()).apply((payload) => {
        if (!payload.docker_key) {
          throw new Error('API did not return a docker key for this license');
        }
        return pulumi.secret(payload.docker_key);
      });

  const clientConfig = authorization.getClientConfigOutput();
  const roleDefinitionId = (roleId: string) =>
    pulumi.interpolate`/subscriptions/${clientConfig.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${roleId}`;

  const resourceGroup = new resources.ResourceGroup(name('rg'), { location });
  const resourceGroupName = resourceGroup.name;

  // ---------------- NETWORKING ----------------
  const vnet = new network.VirtualNetwork(name('vnet'), {
    resourceGroupName,
    location,
    addressSpace: { addressPrefixes: [spokeAddressSpace] },
    ...(dnsServers ? { dhcpOptions: { dnsServers } } : {}),
  });

  // Zones usually live in the hub (other resource group, maybe another subscription).
  const zoneLinks = linkPrivateDnsZonesToSpoke
    ? Object.entries(privateDnsZoneIds).map(([zone, zoneId]) => {
        const match =
          /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Network\/privateDnsZones\/([^/]+)$/i.exec(
            zoneId,
          );
        if (!match) {
          throw new Error(
            `privateDnsZoneIds.${zone} is not a Private DNS zone ID`,
          );
        }
        const [, subscriptionId, zoneResourceGroup, zoneName] = match;
        const provider = new AzureNativeProvider(name(`${zone}-dns-provider`), {
          subscriptionId,
        });

        return new privatedns.VirtualNetworkLink(
          name(`${zone}-dns-link`),
          {
            resourceGroupName: zoneResourceGroup,
            privateZoneName: zoneName,
            location: 'global',
            virtualNetwork: { id: vnet.id },
            registrationEnabled: false,
          },
          { provider },
        );
      })
    : [];

  // All egress goes through the customer's Azure Firewall.
  const routeTable = new network.RouteTable(name('rt'), {
    resourceGroupName,
    location,
    routes: [
      {
        name: 'default-to-firewall',
        addressPrefix: '0.0.0.0/0',
        nextHopType: 'VirtualAppliance',
        nextHopIpAddress: firewallPrivateIp,
      },
    ],
  });

  const denyOtherVnetInbound = {
    name: 'deny-vnet-inbound',
    priority: 4000,
    direction: 'Inbound',
    access: 'Deny',
    protocol: '*',
    sourceAddressPrefix: 'VirtualNetwork',
    sourcePortRange: '*',
    destinationAddressPrefix: '*',
    destinationPortRange: '*',
  };

  // Compute subnet: the VM itself, or the Function App / Web App VNet integration.
  const computeSubnet =
    computeMode === 'vm'
      ? new network.Subnet(name('vm-subnet'), {
          resourceGroupName,
          virtualNetworkName: vnet.name,
          addressPrefix: config.require('vmSubnetPrefix'),
          networkSecurityGroup: {
            id: new network.NetworkSecurityGroup(name('vm-nsg'), {
              resourceGroupName,
              location,
              securityRules: [
                {
                  name: 'allow-appgw-dp-api',
                  priority: 100,
                  direction: 'Inbound',
                  access: 'Allow',
                  protocol: 'Tcp',
                  sourceAddressPrefix: appGatewaySubnetCidr,
                  sourcePortRange: '*',
                  destinationAddressPrefix: '*',
                  destinationPortRange: `${DP_API_PORT}`,
                },
                {
                  name: 'allow-admin-ssh',
                  priority: 110,
                  direction: 'Inbound',
                  access: 'Allow',
                  protocol: 'Tcp',
                  sourceAddressPrefix: config.require('adminSourceCidr'),
                  sourcePortRange: '*',
                  destinationAddressPrefix: '*',
                  destinationPortRange: '22',
                },
                denyOtherVnetInbound,
              ],
            }).id,
          },
          routeTable: { id: routeTable.id },
          defaultOutboundAccess: false,
        })
      : new network.Subnet(name('app-subnet'), {
          resourceGroupName,
          virtualNetworkName: vnet.name,
          addressPrefix: config.require('appSubnetPrefix'),
          delegations: [
            { name: 'app-service', serviceName: 'Microsoft.Web/serverFarms' },
          ],
          routeTable: { id: routeTable.id },
          defaultOutboundAccess: false,
        });

  // Function App mode: the App Gateway reaches the Function App through its Private Endpoint,
  // so the endpoint subnet gets the inbound rules.
  const blobClientCidrs = config.getObject<string[]>('blobClientCidrs') || [];
  const peNsg =
    computeMode === 'functionapp'
      ? new network.NetworkSecurityGroup(name('pe-nsg'), {
          resourceGroupName,
          location,
          securityRules: [
            {
              name: 'allow-spoke',
              priority: 100,
              direction: 'Inbound',
              access: 'Allow',
              protocol: '*',
              sourceAddressPrefix: spokeAddressSpace,
              sourcePortRange: '*',
              destinationAddressPrefix: '*',
              destinationPortRange: '*',
            },
            {
              name: 'allow-appgw-https',
              priority: 110,
              direction: 'Inbound',
              access: 'Allow',
              protocol: 'Tcp',
              sourceAddressPrefix: appGatewaySubnetCidr,
              sourcePortRange: '*',
              destinationAddressPrefix: '*',
              destinationPortRange: '443',
            },
            // Browsers using direct Blob SAS URLs (no blobPublicBaseUrl proxy)
            ...blobClientCidrs.map((cidr, index) => ({
              name: `allow-blob-client-${index}`,
              priority: 120 + index,
              direction: 'Inbound',
              access: 'Allow',
              protocol: 'Tcp',
              sourceAddressPrefix: cidr,
              sourcePortRange: '*',
              destinationAddressPrefix: '*',
              destinationPortRange: '443',
            })),
            denyOtherVnetInbound,
          ],
        })
      : undefined;

  const peSubnet = new network.Subnet(
    name('pe-subnet'),
    {
      resourceGroupName,
      virtualNetworkName: vnet.name,
      addressPrefix: peSubnetPrefix,
      defaultOutboundAccess: false,
      ...(peNsg
        ? {
            networkSecurityGroup: { id: peNsg.id },
            privateEndpointNetworkPolicies: 'Enabled',
          }
        : {}),
    },
    // Subnets of one VNet cannot be updated in parallel.
    { dependsOn: [computeSubnet] },
  );

  const privateEndpoint = (
    suffix: string,
    privateLinkServiceId: pulumi.Input<string>,
    groupId: string,
    zone: string,
  ) => {
    const pe = new network.PrivateEndpoint(name(`${suffix}-pe`), {
      resourceGroupName,
      location,
      subnet: { id: peSubnet.id },
      privateLinkServiceConnections: [
        { name: suffix, privateLinkServiceId, groupIds: [groupId] },
      ],
    });
    const dns = new network.PrivateDnsZoneGroup(name(`${suffix}-pe-dns`), {
      resourceGroupName,
      privateEndpointName: pe.name,
      privateDnsZoneConfigs: [
        { name: suffix, privateDnsZoneId: privateDnsZoneIds[zone] },
      ],
    });

    return { pe, dns };
  };

  const privateEndpointIp = (pe: network.PrivateEndpoint) =>
    pe.networkInterfaces.apply(async (nics) => {
      const nicId = nics?.[0]?.id;
      if (!nicId) return undefined;
      const nic = await network.getNetworkInterface({
        resourceGroupName: nicId.split('/')[4],
        networkInterfaceName: nicId.split('/').pop() as string,
      });

      return nic.ipConfigurations?.[0]?.privateIPAddress;
    });

  // ---------------- STORAGE ----------------
  const storageAccount = new storage.StorageAccount(storageAccountName, {
    resourceGroupName,
    location,
    sku: { name: storage.SkuName.Standard_LRS },
    kind: storage.Kind.StorageV2,
    minimumTlsVersion: storage.MinimumTlsVersion.TLS1_2,
    allowBlobPublicAccess: false,
    publicNetworkAccess: storage.PublicNetworkAccess.Disabled,
    networkRuleSet: { defaultAction: storage.DefaultAction.Deny },
  });

  // Browsers upload/download through SAS URLs, so the host app origin needs CORS.
  new storage.BlobServiceProperties(name('blob-cors'), {
    resourceGroupName,
    accountName: storageAccount.name,
    blobServicesName: 'default',
    cors: {
      corsRules: [
        {
          allowedOrigins,
          allowedMethods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
          allowedHeaders: ['*'],
          exposedHeaders: ['*'],
          maxAgeInSeconds: 3600,
        },
      ],
    },
  });

  const dataContainer = new storage.BlobContainer(name('data'), {
    resourceGroupName,
    accountName: storageAccount.name,
  });

  const storageAccountKey = storage.listStorageAccountKeysOutput({
    resourceGroupName,
    accountName: storageAccount.name,
  }).keys[0].value;
  const storageConnectionString = getConnectionString(
    resourceGroupName,
    storageAccount.name,
  );

  const storagePes = (
    computeMode === 'functionapp'
      ? ['blob', 'file', 'queue', 'table']
      : ['blob']
  ).map((service) =>
    privateEndpoint(service, storageAccount.id, service, service),
  );
  const blobPe = storagePes[0];

  // ---------------- MONGODB ATLAS ----------------
  // Atlas approves the connection on its side; register the output IP/ID in Atlas.
  const atlasPe = atlasPrivateLinkServiceId
    ? new network.PrivateEndpoint(name('atlas-pe'), {
        resourceGroupName,
        location,
        subnet: { id: peSubnet.id },
        manualPrivateLinkServiceConnections: [
          {
            name: 'atlas',
            privateLinkServiceId: atlasPrivateLinkServiceId,
            requestMessage: `Ingestro ${environment}`,
          },
        ],
      })
    : undefined;

  // ---------------- KEY VAULT ----------------
  const vault = new keyvault.Vault(keyVaultName, {
    resourceGroupName,
    location,
    properties: {
      tenantId: clientConfig.tenantId,
      sku: { family: 'A', name: 'standard' },
      enableRbacAuthorization: true,
      publicNetworkAccess: 'Disabled',
      networkAcls: { defaultAction: 'Deny', bypass: 'AzureServices' },
    },
  });
  const vaultPe = privateEndpoint('vault', vault.id, 'vault', 'vault');

  const privateToken =
    config.getSecret('AZURE_PRIVATE_TOKEN') ??
    new random.RandomString(name('private-token'), {
      length: 32,
      special: false,
    }).result;

  // Secrets are written through ARM, so this works with the vault's public access disabled.
  type SecretEntry = {
    file: 'dp' | 'mapping';
    env: string;
    value: pulumi.Input<string>;
  };
  const secretEntries = (
    [
      { file: 'dp', env: 'DP_LICENSE_KEY', value: licenseKey },
      { file: 'dp', env: 'DATA_PIPELINE_DB_URI', value: mongoConnectionString },
      {
        file: 'dp',
        env: 'AZURE_CONNECTION_STRING',
        value: storageConnectionString,
      },
      { file: 'dp', env: 'AZURE_ACCOUNT_KEY', value: storageAccountKey },
      { file: 'dp', env: 'AZURE_PRIVATE_TOKEN', value: privateToken },
      {
        file: 'dp',
        env: 'S3_CONNECTOR_SECRET_KEY',
        value: config.requireSecret('S3_CONNECTOR_SECRET_KEY'),
      },
      {
        file: 'dp',
        env: 'PUSHER_SECRET',
        value: config.getSecret('PUSHER_SECRET'),
      },
      {
        file: 'dp',
        env: 'BREVO_API_KEY',
        value: config.getSecret('BREVO_API_KEY'),
      },
      {
        file: 'dp',
        env: 'SENDGRID_RECEIVER_SECRET_KEY',
        value: config.getSecret('sendgridReceiverSecretKey'),
      },
      { file: 'mapping', env: 'MAPPING_LICENSE_KEY', value: licenseKey },
      {
        file: 'mapping',
        env: 'MAPPING_AZURE_BLOB_ACCOUNT_KEY',
        value: storageAccountKey,
      },
      {
        file: 'mapping',
        env: 'MAPPING_AZURE_OPENAI_API_KEY',
        value: config.getSecret('mappingAzureOpenaiApiKey'),
      },
    ] as (Omit<SecretEntry, 'value'> & { value?: pulumi.Input<string> })[]
  ).filter((entry): entry is SecretEntry => entry.value !== undefined);

  const createSecret = (secret: string, value: pulumi.Input<string>) =>
    new keyvault.Secret(name(secret), {
      resourceGroupName,
      vaultName: vault.name,
      secretName: secret,
      properties: { value },
    });

  const secrets = secretEntries.map((entry) =>
    createSecret(secretName(entry.env), entry.value),
  );
  if (dockerKey) {
    secrets.push(createSecret('registry-password', dockerKey));
  }

  // Role assignment names must be GUIDs.
  const grant = (
    suffix: string,
    principalId: pulumi.Input<string>,
    roleId: string,
    scope: pulumi.Input<string>,
  ) =>
    new authorization.RoleAssignment(name(suffix), {
      roleAssignmentName: new random.RandomUuid(name(`${suffix}-id`)).result,
      principalId,
      principalType: authorization.PrincipalType.ServicePrincipal,
      roleDefinitionId: roleDefinitionId(roleId),
      scope,
    });

  const principalOf = (
    identity: pulumi.Output<{ principalId?: string } | undefined>,
    what: string,
  ) =>
    identity.apply((value) => {
      if (!value?.principalId) {
        throw new Error(`${what} has no system-assigned identity`);
      }
      return value.principalId;
    });

  // Settings shared by both modes.
  const mappingSettings = (
    accountName: string,
    containerName: string,
    moduleEnv: Record<string, string>,
  ) =>
    withoutEmpty({
      MAPPING_LLM_PROVIDER: config.get('mappingLlmProvider') || 'AZURE',
      MAPPING_LLM_TEMPERATURE: `${config.getNumber('mappingLlmTemperature') ?? 0}`,
      MAPPING_AZURE_OPENAI_ENDPOINT: config.get('mappingAzureOpenaiEndpoint'),
      MAPPING_AZURE_OPENAI_API_VERSION:
        config.get('mappingAzureOpenaiApiVersion') || '2024-10-21',
      MAPPING_AZURE_OPENAI_DEPLOYMENT_NAME:
        config.get('mappingAzureOpenaiDeploymentName') || 'gpt-4o-mini',
      MAPPING_STORAGE_PROVIDER: 'AZURE_BLOB',
      MAPPING_AZURE_BLOB_ACCOUNT_NAME: accountName,
      MAPPING_AZURE_BLOB_CONTAINER_NAME: containerName,
      ...moduleEnv,
    });
  const dpSettings = (accountName: string, containerName: string) =>
    withoutEmpty({
      DATA_PIPELINE_DB_NAME: dbName,
      DATA_PIPELINE_LOG_DB_NAME: logDbName,
      PUSHER_APP_ID: config.get('PUSHER_APP_ID'),
      PUSHER_KEY: config.get('PUSHER_KEY'),
      CUSTOM_DOMAIN: config.get('customDomain'),
      AZURE_BLOB_PUBLIC_BASE_URL: blobPublicBaseUrl,
      AZURE_ACCOUNT_NAME: accountName,
      AZURE_STORAGE_CONTAINER_NAME: containerName,
    });

  const commonOutputs = {
    healthProbePath: HEALTH_PROBE_PATH,
    keyVaultName: vault.name,
    storageAccountName: storageAccount.name,
    blobPrivateEndpointIp: privateEndpointIp(blobPe.pe),
    vaultPrivateEndpointIp: privateEndpointIp(vaultPe.pe),
    atlasPrivateEndpointId: atlasPe?.id,
    atlasPrivateEndpointIp: atlasPe ? privateEndpointIp(atlasPe) : undefined,
    computeMode,
    dpImage,
    mappingImage,
  };
  const networkReady = [
    vaultPe.dns,
    ...storagePes.map((pe) => pe.dns),
    ...zoneLinks,
    ...secrets,
  ];

  if (computeMode === 'functionapp') {
    // ---------------- FUNCTION APP + MAPPING WEB APP ----------------
    const fileShare = new storage.FileShare(name('hyperformula'), {
      resourceGroupName,
      accountName: storageAccount.name,
      shareName: 'hyperformula',
    });

    const functionPlan = new web.AppServicePlan(name('func-plan'), {
      resourceGroupName,
      location,
      kind: 'functionapp,linux',
      reserved: true,
      sku: {
        name: config.get('functionPlanSku') || 'EP1',
        tier: 'ElasticPremium',
      },
      maximumElasticWorkerCount: config.getNumber('functionMaxInstances') || 3,
    });
    const mappingPlan = new web.AppServicePlan(name('mapping-plan'), {
      resourceGroupName,
      location,
      kind: 'app,linux',
      reserved: true,
      sku: { name: config.get('mappingPlanSku') || 'P1v3' },
    });

    // Private apps: no public access, outbound through the spoke (UDR to the firewall),
    // images pulled over the VNet, Key Vault references resolved with the app identity.
    const privateApp = (
      appName: string,
      plan: web.AppServicePlan,
      kind: string,
      image: string,
      siteConfig: pulumi.Input<object>,
    ) =>
      new web.WebApp(appName, {
        resourceGroupName,
        location,
        serverFarmId: plan.id,
        kind,
        reserved: true,
        identity: { type: 'SystemAssigned' },
        keyVaultReferenceIdentity: 'SystemAssigned',
        httpsOnly: true,
        publicNetworkAccess: 'Disabled',
        virtualNetworkSubnetId: computeSubnet.id,
        vnetRouteAllEnabled: true,
        vnetImagePullEnabled: true,
        vnetContentShareEnabled: true,
        siteConfig: {
          linuxFxVersion: `DOCKER|${image}`,
          acrUseManagedIdentityCreds: !!acrLoginServer,
          http20Enabled: true,
          ftpsState: 'Disabled',
          ...siteConfig,
        },
      });

    const functionApp = privateApp(
      name('func'),
      functionPlan,
      'functionapp,linux,container',
      dpImage,
      { minimumElasticInstanceCount: 1 },
    );
    const mappingApp = privateApp(
      name('mapping'),
      mappingPlan,
      'app,linux,container',
      mappingImage,
      { alwaysOn: true },
    );

    const functionPe = privateEndpoint(
      'func',
      functionApp.id,
      'sites',
      'sites',
    );
    const mappingPe = privateEndpoint(
      'mapping',
      mappingApp.id,
      'sites',
      'sites',
    );

    const functionPrincipal = principalOf(functionApp.identity, 'Function App');
    const mappingPrincipal = principalOf(mappingApp.identity, 'Mapping app');
    const roles = [
      grant(
        'func-kv-secrets-user',
        functionPrincipal,
        ROLE_KEY_VAULT_SECRETS_USER,
        vault.id,
      ),
      grant(
        'mapping-kv-secrets-user',
        mappingPrincipal,
        ROLE_KEY_VAULT_SECRETS_USER,
        vault.id,
      ),
      ...(acrId
        ? [
            grant('func-acr-pull', functionPrincipal, ROLE_ACR_PULL, acrId),
            grant('mapping-acr-pull', mappingPrincipal, ROLE_ACR_PULL, acrId),
          ]
        : []),
    ];

    const kvRef = (env: string) =>
      pulumi.interpolate`@Microsoft.KeyVault(VaultName=${vault.name};SecretName=${secretName(env)})`;
    const secretRefs = (file: 'dp' | 'mapping') =>
      Object.fromEntries(
        secretEntries
          .filter((entry) => entry.file === file)
          .map((entry) => [entry.env, kvRef(entry.env)]),
      );
    const registrySettings: Record<
      string,
      pulumi.Input<string>
    > = acrLoginServer
      ? { DOCKER_REGISTRY_SERVER_URL: `https://${acrLoginServer}` }
      : {
          DOCKER_REGISTRY_SERVER_URL: 'https://index.docker.io',
          DOCKER_REGISTRY_SERVER_USERNAME: 'getnuvo',
          DOCKER_REGISTRY_SERVER_PASSWORD: pulumi.interpolate`@Microsoft.KeyVault(VaultName=${vault.name};SecretName=registry-password)`,
        };
    const functionUrl = pulumi.interpolate`https://${functionApp.defaultHostName}`;
    const mappingUrl = pulumi.interpolate`https://${mappingApp.defaultHostName}`;

    // Applied after the role assignments, so Key Vault references resolve on the first start.
    const settingsDependsOn = [...roles, ...networkReady];
    new web.WebAppApplicationSettings(
      name('func-settings'),
      {
        name: functionApp.name,
        resourceGroupName,
        properties: pulumi
          .all([storageAccount.name, dataContainer.name])
          .apply(([accountName, containerName]) =>
            pulumi.output<Record<string, pulumi.Input<string>>>({
              ...dpSettings(accountName, containerName),
              ...secretRefs('dp'),
              ...registrySettings,
              AzureWebJobsStorage: kvRef('AZURE_CONNECTION_STRING'),
              FUNCTIONS_EXTENSION_VERSION: '~4',
              FUNCTIONS_WORKER_RUNTIME: 'node',
              WEBSITES_ENABLE_APP_SERVICE_STORAGE: 'false',
              CLOUD_PROVIDER: 'AZURE',
              AZURE_FUNCTION_BASE_URL: functionUrl,
              MAPPING_BASE_URL: mappingUrl,
            }),
          ),
      },
      { dependsOn: settingsDependsOn },
    );
    new web.WebAppApplicationSettings(
      name('mapping-settings'),
      {
        name: mappingApp.name,
        resourceGroupName,
        properties: pulumi
          .all([storageAccount.name, dataContainer.name, mappingModuleEnv])
          .apply(([accountName, containerName, moduleEnv]) =>
            pulumi.output<Record<string, pulumi.Input<string>>>({
              ...mappingSettings(accountName, containerName, moduleEnv),
              ...secretRefs('mapping'),
              ...registrySettings,
              WEBSITES_PORT: '8000',
              MAPPING_PORT: '8000',
              WEBSITES_ENABLE_APP_SERVICE_STORAGE: 'false',
            }),
          ),
      },
      { dependsOn: settingsDependsOn },
    );

    // With public access disabled, Log stream / Kudu are not reachable from outside the network:
    // ship console and function logs to Log Analytics (platform path, no firewall egress).
    const logs = new operationalinsights.Workspace(name('logs'), {
      resourceGroupName,
      location,
      sku: { name: 'PerGB2018' },
      retentionInDays: config.getNumber('logRetentionDays') || 30,
    });
    [
      { app: functionApp, suffix: 'func', categories: ['FunctionAppLogs'] },
      {
        app: mappingApp,
        suffix: 'mapping',
        categories: ['AppServiceConsoleLogs', 'AppServiceHTTPLogs'],
      },
    ].forEach(({ app, suffix, categories }) => {
      new monitor.DiagnosticSetting(name(`${suffix}-diagnostics`), {
        resourceUri: app.id,
        name: 'ingestro-logs',
        workspaceId: logs.id,
        logs: categories.map((category) => ({ category, enabled: true })),
      });
    });

    // Shared HyperFormula working directory (the API reads what the worker functions write).
    new web.WebAppAzureStorageAccounts(
      name('func-storage-mounts'),
      {
        name: functionApp.name,
        resourceGroupName,
        properties: {
          hyperformula: {
            type: web.AzureStorageType.AzureFiles,
            accountName: storageAccount.name,
            shareName: fileShare.name,
            accessKey: storageAccountKey,
            mountPath: HYPERFORMULA_MOUNT_PATH,
          },
        },
      },
      { dependsOn: networkReady },
    );

    return {
      ...commonOutputs,
      // Host only: the embeddable SDKs append /dp/api/v1 to baseUrl themselves.
      endpoint: functionUrl,
      functionAppName: functionApp.name,
      logAnalyticsWorkspaceId: logs.id,
      functionAppHostname: functionApp.defaultHostName,
      functionAppPrivateEndpointIp: privateEndpointIp(functionPe.pe),
      mappingAppHostname: mappingApp.defaultHostName,
      mappingPrivateEndpointIp: privateEndpointIp(mappingPe.pe),
    };
  }

  // ---------------- VM (docker compose) ----------------
  const vmSize = config.get('vmSize') || 'Standard_D4s_v5';
  const dataDiskSizeGb = config.getNumber('dataDiskSizeGb') || 128;
  const adminUsername = config.get('adminUsername') || 'ingestro';
  const adminSshPublicKey = config.require('adminSshPublicKey');
  const deployNonce = config.get('deployNonce') || '';

  const nic = new network.NetworkInterface(name('vm-nic'), {
    resourceGroupName,
    location,
    ipConfigurations: [
      {
        name: 'ipconfig',
        subnet: { id: computeSubnet.id },
        privateIPAllocationMethod: 'Dynamic',
      },
    ],
  });

  const vm = new compute.VirtualMachine(name('vm'), {
    resourceGroupName,
    location,
    hardwareProfile: { vmSize },
    identity: { type: compute.ResourceIdentityType.SystemAssigned },
    networkProfile: { networkInterfaces: [{ id: nic.id, primary: true }] },
    osProfile: {
      computerName: name('vm'),
      adminUsername,
      customData: toBase64(readFile('scripts/azure-docker/cloud-init.yaml')),
      linuxConfiguration: {
        disablePasswordAuthentication: true,
        ssh: {
          publicKeys: [
            {
              path: `/home/${adminUsername}/.ssh/authorized_keys`,
              keyData: adminSshPublicKey,
            },
          ],
        },
      },
    },
    storageProfile: {
      imageReference: {
        publisher: 'Canonical',
        offer: 'ubuntu-24_04-lts',
        sku: 'server',
        version: 'latest',
      },
      osDisk: {
        createOption: compute.DiskCreateOptionTypes.FromImage,
        managedDisk: {
          storageAccountType: compute.StorageAccountTypes.Premium_LRS,
        },
        deleteOption: compute.DiskDeleteOptionTypes.Delete,
      },
      dataDisks: [
        {
          lun: 0,
          createOption: compute.DiskCreateOptionTypes.Empty,
          diskSizeGB: dataDiskSizeGb,
          managedDisk: {
            storageAccountType: compute.StorageAccountTypes.Premium_LRS,
          },
        },
      ],
    },
    diagnosticsProfile: { bootDiagnostics: { enabled: true } },
  });

  const vmPrincipalId = principalOf(vm.identity, 'VM');
  const kvRole = grant(
    'vm-kv-secrets-user',
    vmPrincipalId,
    ROLE_KEY_VAULT_SECRETS_USER,
    vault.id,
  );
  const acrRole = acrId
    ? grant('vm-acr-pull', vmPrincipalId, ROLE_ACR_PULL, acrId)
    : undefined;

  const secretMap = secretEntries
    .map((entry) => `${entry.file}:${entry.env}=${secretName(entry.env)}`)
    .join(' ');

  new compute.VirtualMachineRunCommandByVirtualMachine(
    name('deploy'),
    {
      resourceGroupName,
      vmName: vm.name,
      runCommandName: 'ingestro-deploy',
      location,
      source: { script: readFile('scripts/azure-docker/deploy.sh') },
      parameters: [
        { name: 'VAULT_NAME', value: vault.name },
        { name: 'SECRET_MAP', value: secretMap },
        {
          name: 'COMPOSE_B64',
          value: toBase64(readFile('docker/docker-compose.yml')),
        },
        {
          name: 'DP_ENV_B64',
          value: pulumi
            .all([storageAccount.name, dataContainer.name])
            .apply(([accountName, containerName]) =>
              toBase64(envLines(dpSettings(accountName, containerName))),
            ),
        },
        { name: 'DP_IMAGE', value: dpImage },
        { name: 'MAPPING_IMAGE', value: mappingImage },
        { name: 'DP_API_PORT', value: `${DP_API_PORT}` },
        { name: 'REGISTRY_SERVER', value: registryServer },
        { name: 'REGISTRY_AUTH', value: acrLoginServer ? 'acr' : 'password' },
        { name: 'REGISTRY_USERNAME', value: 'getnuvo' },
        { name: 'DEPLOY_NONCE', value: deployNonce },
        {
          name: 'SECRET_VERSIONS',
          value: pulumi
            .all(
              secrets.map((secret) => secret.properties.secretUriWithVersion),
            )
            .apply((uris) => uris.join(' ')),
        },
      ],
      // Protected: may contain MAPPING_MODULE_ENV credentials; not returned by the Azure API.
      protectedParameters: [
        {
          name: 'MAPPING_ENV_B64',
          value: pulumi
            .all([storageAccount.name, dataContainer.name, mappingModuleEnv])
            .apply(([accountName, containerName, moduleEnv]) =>
              toBase64(
                envLines(
                  mappingSettings(accountName, containerName, moduleEnv),
                ),
              ),
            ),
        },
      ],
      asyncExecution: false,
      timeoutInSeconds: 1800,
      treatFailureAsDeploymentFailure: true,
    },
    {
      dependsOn: [kvRole, ...networkReady, ...(acrRole ? [acrRole] : [])],
    },
  );

  const vmPrivateIp = nic.ipConfigurations.apply(
    (configs) => configs?.[0]?.privateIPAddress,
  );

  return {
    ...commonOutputs,
    // Host only: the embeddable SDKs append /dp/api/v1 to baseUrl themselves.
    endpoint: pulumi.interpolate`http://${vmPrivateIp}:${DP_API_PORT}`,
    vmPrivateIp,
    dpApiPort: DP_API_PORT,
    vmId: vm.id,
  };
};
