// Ingestro DP self-hosted on an Azure VM with docker compose, private network only.
// The spoke (VNet, VM, Storage, Key Vault, Private Endpoints) is created here; the hub
// (Azure Firewall, App Gateway, Private DNS zones, peering) belongs to the customer and is
// passed in as config.

import * as fs from 'fs';
import * as path from 'path';
import * as pulumi from '@pulumi/pulumi';
import * as authorization from '@pulumi/azure-native/authorization';
import * as compute from '@pulumi/azure-native/compute';
import * as keyvault from '@pulumi/azure-native/keyvault';
import * as network from '@pulumi/azure-native/network';
import * as resources from '@pulumi/azure-native/resources';
import * as storage from '@pulumi/azure-native/storage';
import * as random from '@pulumi/random';
import { getConnectionString } from './helpers';
import { fetchFunctionList } from './utils/ingestro';

const ROLE_KEY_VAULT_SECRETS_USER = '4633458b-17de-408a-b874-0445c86b69e6';
const ROLE_ACR_PULL = '7f951dff-4bc7-4b4a-8ab8-1bf7a36cdeb6';
const DP_API_PORT = 8080;

interface PrivateDnsZoneIds {
  blob: string;
  vault: string;
}

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

export const run = () => {
  const config = new pulumi.Config();

  // ---------------- CONFIG ----------------
  const prefix = config.get('prefix') || 'ingestro';
  const environment = config.require('environment');
  const location = config.get('location') || 'germanywestcentral';
  const name = (suffix: string) => `${prefix}-${environment}-${suffix}`;

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

  const vmSize = config.get('vmSize') || 'Standard_D4s_v5';
  const dataDiskSizeGb = config.getNumber('dataDiskSizeGb') || 128;
  const adminUsername = config.get('adminUsername') || 'ingestro';
  const adminSshPublicKey = config.require('adminSshPublicKey');

  const spokeAddressSpace = config.require('spokeAddressSpace');
  const vmSubnetPrefix = config.require('vmSubnetPrefix');
  const peSubnetPrefix = config.require('peSubnetPrefix');
  const firewallPrivateIp = config.require('firewallPrivateIp');
  const appGatewaySubnetCidr = config.require('appGatewaySubnetCidr');
  const adminSourceCidr = config.require('adminSourceCidr');
  const dnsServers = config.getObject<string[]>('dnsServers');
  const privateDnsZoneIds =
    config.requireObject<PrivateDnsZoneIds>('privateDnsZoneIds');
  if (!privateDnsZoneIds.blob || !privateDnsZoneIds.vault) {
    throw new Error('privateDnsZoneIds must contain "blob" and "vault".');
  }

  const licenseKey = config.requireSecret('INGESTRO_LICENSE_KEY');
  const mongoConnectionString = config.requireSecret('MONGO_CONNECTION_STRING');
  const atlasPrivateLinkServiceId = config.get('ATLAS_PRIVATE_LINK_SERVICE_ID');
  const dbName = config.get('DB_NAME') || 'ingestro';
  const logDbName = config.get('LOG_DB_NAME') || 'ingestro_logging';
  const allowedOrigins = config.requireObject<string[]>('allowedOrigins');

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

  const vmNsg = new network.NetworkSecurityGroup(name('vm-nsg'), {
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
        sourceAddressPrefix: adminSourceCidr,
        sourcePortRange: '*',
        destinationAddressPrefix: '*',
        destinationPortRange: '22',
      },
      {
        name: 'deny-vnet-inbound',
        priority: 4000,
        direction: 'Inbound',
        access: 'Deny',
        protocol: '*',
        sourceAddressPrefix: 'VirtualNetwork',
        sourcePortRange: '*',
        destinationAddressPrefix: '*',
        destinationPortRange: '*',
      },
    ],
  });

  const vmSubnet = new network.Subnet(name('vm-subnet'), {
    resourceGroupName,
    virtualNetworkName: vnet.name,
    addressPrefix: vmSubnetPrefix,
    networkSecurityGroup: { id: vmNsg.id },
    routeTable: { id: routeTable.id },
    defaultOutboundAccess: false,
  });

  const peSubnet = new network.Subnet(
    name('pe-subnet'),
    {
      resourceGroupName,
      virtualNetworkName: vnet.name,
      addressPrefix: peSubnetPrefix,
      defaultOutboundAccess: false,
    },
    // Subnets of one VNet cannot be updated in parallel.
    { dependsOn: [vmSubnet] },
  );

  const privateEndpoint = (
    suffix: string,
    privateLinkServiceId: pulumi.Input<string>,
    groupId: string,
    privateDnsZoneId: string,
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
      privateDnsZoneConfigs: [{ name: suffix, privateDnsZoneId }],
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

  const blobPe = privateEndpoint(
    'blob',
    storageAccount.id,
    'blob',
    privateDnsZoneIds.blob,
  );

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
  const vaultPe = privateEndpoint(
    'vault',
    vault.id,
    'vault',
    privateDnsZoneIds.vault,
  );

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

  // ---------------- VM ----------------
  const nic = new network.NetworkInterface(name('vm-nic'), {
    resourceGroupName,
    location,
    ipConfigurations: [
      {
        name: 'ipconfig',
        subnet: { id: vmSubnet.id },
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

  const vmPrincipalId = vm.identity.apply((identity) => {
    if (!identity?.principalId) {
      throw new Error('VM has no system-assigned identity');
    }
    return identity.principalId;
  });

  // Role assignment names must be GUIDs.
  const roleAssignmentName = (suffix: string) =>
    new random.RandomUuid(name(`${suffix}-id`)).result;

  const kvRole = new authorization.RoleAssignment(name('vm-kv-secrets-user'), {
    roleAssignmentName: roleAssignmentName('vm-kv-secrets-user'),
    principalId: vmPrincipalId,
    principalType: authorization.PrincipalType.ServicePrincipal,
    roleDefinitionId: roleDefinitionId(ROLE_KEY_VAULT_SECRETS_USER),
    scope: vault.id,
  });
  const acrRole = acrId
    ? new authorization.RoleAssignment(name('vm-acr-pull'), {
        roleAssignmentName: roleAssignmentName('vm-acr-pull'),
        principalId: vmPrincipalId,
        principalType: authorization.PrincipalType.ServicePrincipal,
        roleDefinitionId: roleDefinitionId(ROLE_ACR_PULL),
        scope: acrId,
      })
    : undefined;

  // ---------------- DEPLOY (docker compose via Run Command) ----------------
  const dpEnv = envLines({
    DATA_PIPELINE_DB_NAME: dbName,
    DATA_PIPELINE_LOG_DB_NAME: logDbName,
    PUSHER_APP_ID: config.get('PUSHER_APP_ID'),
    PUSHER_KEY: config.get('PUSHER_KEY'),
    CUSTOM_DOMAIN: config.get('customDomain'),
  });
  const mappingEnv = (
    accountName: string,
    containerName: string,
    moduleEnv: Record<string, string>,
  ) =>
    envLines({
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
              toBase64(
                dpEnv +
                  envLines({
                    AZURE_ACCOUNT_NAME: accountName,
                    AZURE_STORAGE_CONTAINER_NAME: containerName,
                  }),
              ),
            ),
        },
        { name: 'DP_IMAGE', value: `${imageRepo}/pipelines:${dpVersion}` },
        {
          name: 'MAPPING_IMAGE',
          value: `${imageRepo}/mapping:${mappingVersion}`,
        },
        { name: 'DP_API_PORT', value: `${DP_API_PORT}` },
        { name: 'REGISTRY_SERVER', value: registryServer },
        { name: 'REGISTRY_AUTH', value: acrLoginServer ? 'acr' : 'password' },
        { name: 'REGISTRY_USERNAME', value: 'getnuvo' },
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
              toBase64(mappingEnv(accountName, containerName, moduleEnv)),
            ),
        },
      ],
      asyncExecution: false,
      timeoutInSeconds: 1800,
      treatFailureAsDeploymentFailure: true,
    },
    {
      dependsOn: [
        kvRole,
        vaultPe.dns,
        blobPe.dns,
        ...secrets,
        ...(acrRole ? [acrRole] : []),
      ],
    },
  );

  const vmPrivateIp = nic.ipConfigurations.apply(
    (configs) => configs?.[0]?.privateIPAddress,
  );

  return {
    // Host only: the embeddable SDKs append /dp/api/v1 to baseUrl themselves.
    endpoint: pulumi.interpolate`http://${vmPrivateIp}:${DP_API_PORT}`,
    vmPrivateIp,
    dpApiPort: DP_API_PORT,
    healthProbePath: '/dp/api/v1/management/health',
    vmId: vm.id,
    keyVaultName: vault.name,
    storageAccountName: storageAccount.name,
    blobPrivateEndpointIp: privateEndpointIp(blobPe.pe),
    vaultPrivateEndpointIp: privateEndpointIp(vaultPe.pe),
    atlasPrivateEndpointId: atlasPe?.id,
    atlasPrivateEndpointIp: atlasPe ? privateEndpointIp(atlasPe) : undefined,
    dpImage: `${imageRepo}/pipelines:${dpVersion}`,
  };
};
