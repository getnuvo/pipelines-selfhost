import { randomBytes } from 'node:crypto';
import * as v from './validate';

export type Answer = string | string[];
export type Answers = Record<string, Answer | undefined>;

export interface Question {
  /** Key in the answers file and in `answers`. */
  key: string;
  /** Stack config key it is stored in (path syntax for objects); none for wizard-only choices. */
  config?: string;
  section: string;
  kind: 'text' | 'secret' | 'select' | 'list';
  message: string;
  choices?: { value: string; name: string }[];
  default?: (answers: Answers) => string | undefined;
  /** Not asked when false; its config key is removed. */
  when?: (answers: Answers) => boolean;
  optional?: boolean;
  /** For lists: applied to each item. */
  validate?: (answers: Answers) => v.Validator;
  /** Read a wizard-only choice back from an existing stack. */
  fromConfig?: (read: (key: string) => unknown) => string | undefined;
  /** Never prompted: taken from the answers file, the stack, or `generate`. */
  hidden?: boolean;
  generate?: () => string;
}

export const LIVE_SELF_HOST_URL =
  'https://api-gateway.ingestro.com/dp/api/v1/auth/self-host-deployment';

const dnsZone = (key: string, zone: string): Question => ({
  key: `privateDnsZone_${key}`,
  config: `privateDnsZoneIds.${key}`,
  section: 'Private DNS zones (hub)',
  kind: 'text',
  message: `Resource ID of ${zone}`,
  validate: () => v.resourceId('Microsoft.Network/privateDnsZones', zone),
});

export const QUESTIONS: Question[] = [
  // ---- Stack ----
  {
    key: 'prefix',
    config: 'prefix',
    section: 'Stack',
    kind: 'text',
    message: 'Name prefix for Azure resources',
    default: () => 'ingestro',
    validate: (a) => (value) =>
      v.azureNameParts(value, String(a.environment ?? 'dev')),
  },
  {
    key: 'environment',
    config: 'environment',
    section: 'Stack',
    kind: 'text',
    message: 'Environment (part of resource names)',
    default: () => 'dev',
    validate: (a) => (value) =>
      v.azureNameParts(String(a.prefix ?? 'ingestro'), value),
  },
  {
    key: 'location',
    config: 'location',
    section: 'Stack',
    kind: 'text',
    message: 'Azure region (same region as the hub and Atlas)',
    default: () => 'germanywestcentral',
    validate: () => (value) =>
      /^[a-z0-9]+$/.test(value)
        ? undefined
        : 'Region name, e.g. germanywestcentral.',
  },

  // ---- Release ----
  {
    key: 'version',
    config: 'version',
    section: 'Release',
    kind: 'text',
    message: 'Pipelines version (image tag ingestro/pipelines:<version>)',
  },
  {
    key: 'mappingVersion',
    config: 'mappingVersion',
    section: 'Release',
    kind: 'text',
    message: 'Mapping version (image tag ingestro/mapping:<tag>)',
    validate: () => (value) =>
      value === 'latest'
        ? 'Pin a concrete tag; `latest` moves and breaks rollback.'
        : undefined,
  },
  {
    key: 'selfHostDeploymentUrl',
    config: 'selfHostDeploymentUrl',
    section: 'Release',
    kind: 'text',
    message: 'Self-host deployment API',
    hidden: true,
    optional: true,
    validate: () => v.httpsUrl,
  },

  // ---- License ----
  {
    key: 'licenseKey',
    config: 'INGESTRO_LICENSE_KEY',
    section: 'License',
    kind: 'secret',
    message: 'DP license key for this environment',
  },

  // ---- Plans ----
  {
    key: 'functionPlanSku',
    config: 'functionPlanSku',
    section: 'App Service plans',
    kind: 'select',
    message: 'Function App plan (Elastic Premium)',
    choices: ['EP1', 'EP2', 'EP3'].map((sku) => ({ value: sku, name: sku })),
    default: () => 'EP1',
  },
  {
    key: 'functionMaxInstances',
    config: 'functionMaxInstances',
    section: 'App Service plans',
    kind: 'text',
    message: 'Function App maximum instances',
    default: () => '3',
    validate: () => (value) =>
      /^[1-9]\d?$/.test(value) ? undefined : 'A number from 1 to 99.',
  },
  {
    key: 'mappingPlanSku',
    config: 'mappingPlanSku',
    section: 'App Service plans',
    kind: 'text',
    message: 'Mapping Web App plan',
    default: () => 'P1v3',
    validate: () => (value) =>
      /^P\dv[23]$/.test(value) ? undefined : 'Premium v2/v3 SKU, e.g. P1v3.',
  },

  // ---- Network ----
  {
    key: 'spokeAddressSpace',
    config: 'spokeAddressSpace',
    section: 'Spoke network',
    kind: 'text',
    message:
      'Spoke VNet address space (must not overlap the hub, AVD or other spokes)',
    validate: () => v.cidr,
  },
  {
    key: 'appSubnetPrefix',
    config: 'appSubnetPrefix',
    section: 'Spoke network',
    kind: 'text',
    message: 'App subnet (VNet integration, /26 or larger)',
    validate: (a) => v.subnetIn(String(a.spokeAddressSpace), 26),
  },
  {
    key: 'peSubnetPrefix',
    config: 'peSubnetPrefix',
    section: 'Spoke network',
    kind: 'text',
    message: 'Private Endpoint subnet (/27 or larger)',
    validate: (a) =>
      v.all(
        v.subnetIn(String(a.spokeAddressSpace), 27),
        v.notOverlapping({ 'the app subnet': a.appSubnetPrefix as string }),
      ),
  },
  {
    key: 'firewallPrivateIp',
    config: 'firewallPrivateIp',
    section: 'Hub network',
    kind: 'text',
    message: 'Azure Firewall private IP (next hop for all egress)',
    validate: (a) => v.ipOutside(String(a.spokeAddressSpace), 'the spoke'),
  },
  {
    key: 'appGatewaySubnetCidr',
    config: 'appGatewaySubnetCidr',
    section: 'Hub network',
    kind: 'text',
    message: 'App Gateway subnet (the only source allowed to reach the API)',
    validate: (a) =>
      v.notOverlapping({ 'the spoke': a.spokeAddressSpace as string }),
  },

  // ---- DNS ----
  {
    key: 'dnsMode',
    section: 'Private DNS zones (hub)',
    kind: 'select',
    message: 'How does the spoke resolve privatelink.* names?',
    choices: [
      {
        value: 'proxy',
        name: 'Through a DNS proxy in the hub (e.g. Azure Firewall DNS proxy)',
      },
      {
        value: 'link',
        name: 'Link the hub Private DNS zones to the spoke VNet (needs write access to the zones)',
      },
    ],
    default: () => 'proxy',
    fromConfig: (read) =>
      read('linkPrivateDnsZonesToSpoke') === 'true'
        ? 'link'
        : read('dnsServers')
          ? 'proxy'
          : undefined,
  },
  {
    key: 'dnsServers',
    config: 'dnsServers',
    section: 'Private DNS zones (hub)',
    kind: 'list',
    message: 'DNS server IPs for the spoke (comma-separated)',
    when: (a) => a.dnsMode === 'proxy',
    validate: () => v.ipv4,
  },
  dnsZone('blob', 'privatelink.blob.core.windows.net'),
  dnsZone('file', 'privatelink.file.core.windows.net'),
  dnsZone('queue', 'privatelink.queue.core.windows.net'),
  dnsZone('table', 'privatelink.table.core.windows.net'),
  dnsZone('vault', 'privatelink.vaultcore.azure.net'),
  dnsZone('sites', 'privatelink.azurewebsites.net'),

  // ---- App ----
  {
    key: 'apiBaseUrl',
    config: 'apiBaseUrl',
    section: 'Access',
    kind: 'text',
    message:
      'App Gateway URL clients use as baseUrl (leave empty if not known yet)',
    optional: true,
    validate: () => v.baseUrl,
  },
  {
    key: 'allowedOrigins',
    config: 'allowedOrigins',
    section: 'Access',
    kind: 'list',
    message:
      'Origins of your app embedding Ingestro, for file uploads (comma-separated, may be empty)',
    optional: true,
    validate: () => v.origin,
  },
  {
    key: 'blobAccess',
    section: 'Access',
    kind: 'select',
    message: 'How do browsers reach Blob storage for file uploads/downloads?',
    choices: [
      {
        value: 'proxy',
        name: 'Through an App Gateway path rule /blob/* (recommended, stays behind the WAF)',
      },
      {
        value: 'direct',
        name: 'Directly to the Blob Private Endpoint from browser subnets',
      },
    ],
    default: () => 'proxy',
    fromConfig: (read) =>
      read('blobPublicBaseUrl')
        ? 'proxy'
        : read('blobClientCidrs')
          ? 'direct'
          : undefined,
  },
  {
    key: 'blobPublicBaseUrl',
    config: 'blobPublicBaseUrl',
    section: 'Access',
    kind: 'text',
    message:
      'App Gateway URL of the /blob rule, e.g. https://ingestro.company.local/blob',
    when: (a) => a.blobAccess === 'proxy',
    default: (a) =>
      a.apiBaseUrl
        ? `${String(a.apiBaseUrl).replace(/\/$/, '')}/blob`
        : undefined,
    validate: () => v.httpsUrl,
  },
  {
    key: 'blobClientCidrs',
    config: 'blobClientCidrs',
    section: 'Access',
    kind: 'list',
    message: 'Browser subnets allowed to reach Blob (comma-separated CIDRs)',
    when: (a) => a.blobAccess === 'direct',
    validate: () => v.cidr,
  },

  // ---- Mapping LLM ----
  {
    key: 'mappingAzureOpenaiEndpoint',
    config: 'mappingAzureOpenaiEndpoint',
    section: 'Mapping module (Azure OpenAI)',
    kind: 'text',
    message: 'Azure OpenAI endpoint, e.g. https://<resource>.openai.azure.com',
    validate: () => v.httpsUrl,
  },
  {
    key: 'mappingAzureOpenaiDeploymentName',
    config: 'mappingAzureOpenaiDeploymentName',
    section: 'Mapping module (Azure OpenAI)',
    kind: 'text',
    message: 'Azure OpenAI deployment name',
    default: () => 'gpt-4o-mini',
  },
  {
    key: 'mappingAzureOpenaiApiKey',
    config: 'mappingAzureOpenaiApiKey',
    section: 'Mapping module (Azure OpenAI)',
    kind: 'secret',
    message: 'Azure OpenAI API key',
  },

  // ---- Database ----
  {
    key: 'mongoConnectionString',
    config: 'MONGO_CONNECTION_STRING',
    section: 'Database',
    kind: 'secret',
    message: 'MongoDB connection string (Atlas)',
    validate: () => v.mongoUri,
  },
  {
    key: 's3ConnectorSecretKey',
    config: 'S3_CONNECTOR_SECRET_KEY',
    section: 'Database',
    kind: 'secret',
    message: 'Key that encrypts stored connector credentials',
    hidden: true,
    generate: () => randomBytes(32).toString('hex'),
  },
];

/** Config keys the wizard always sets, derived from other answers. */
export const derivedConfig = (
  answers: Answers,
): Record<string, string | undefined> => ({
  provider: 'azure-docker',
  linkPrivateDnsZonesToSpoke: answers.dnsMode === 'link' ? 'true' : 'false',
});

export const isActive = (question: Question, answers: Answers) =>
  question.when ? question.when(answers) : true;
