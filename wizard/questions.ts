import { randomBytes } from 'node:crypto';
import type { Discovery, FoundResource } from './azure';
import {
  DEFAULT_SSH_KEY,
  detectPublicIp,
  sshPublicKeys,
  TEST_HUB,
  testHubZoneId,
} from './hub';
import { checkLicense, selfHostUrlFor } from './license';

/** Stored until the Atlas private endpoint is registered; replaced in the second round. */
export const ATLAS_PENDING =
  'mongodb+srv://atlas-private-endpoint-pending.invalid/';

/** Atlas private endpoint hosts look like <cluster>-pl-0.<id>.mongodb.net. */
export const isAtlasPrivate = (uri: unknown) =>
  typeof uri === 'string' &&
  // Only the host counts: `-pl-0` in a username must not make a public URI look private.
  /^mongodb\+srv:\/\/(?:[^@/]*@)?[^/?@]*-pl-\d(?:[./?]|$)/.test(uri);
import * as v from './validate';

export type Answer = string | string[];
export type Answers = Record<string, Answer | undefined>;

export interface Choice {
  value: string;
  name: string;
  description?: string;
  when?: (answers: Answers) => boolean;
}

export const choicesFor = (question: Question, answers: Answers) =>
  (question.choices ?? []).filter((choice) => choice.when?.(answers) ?? true);

export interface Question {
  /** Key in the answers file and in `answers`. */
  key: string;
  /** Stack config key it is stored in (path syntax for objects); none for wizard-only choices. */
  config?: string;
  section: string;
  kind: 'text' | 'secret' | 'select' | 'list';
  message: string;
  /** `description` is shown under the list while highlighted; `when` hides a choice. */
  choices?: Choice[];
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
  /** Slower check run after `validate` passes (e.g. a network call); returns an error message. */
  check?: (value: string, answers: Answers) => Promise<string | undefined>;
  /** A value decided by earlier answers: used without asking when defined. */
  auto?: (answers: Answers) => Answer | undefined;
  /** With the test hub: the value comes from the hub instead of being asked. */
  testHub?: (context: { subscriptionId: string }) => Answer | undefined;
  /** Not asked when the stack already has a value or exactly one candidate is found. */
  autoAccept?: boolean;
  /** Candidates found in Azure: offered as a list, or used directly in batch mode when there is exactly one. */
  discover?: (
    discovery: Discovery,
    answers: Answers,
  ) => Promise<{ value: string; name: string }[]>;
}

const resourceGroupOf = (id: string) => id.split('/')[4];

const describe = (resource: FoundResource) =>
  `${resource.name}  (resource group ${resourceGroupOf(resource.id)}, subscription ${resource.subscriptionId})`;

const dnsZone = (key: string, zone: string): Question => ({
  key: `privateDnsZone_${key}`,
  config: `privateDnsZoneIds.${key}`,
  section: 'Hub',
  kind: 'text',
  message: `Resource ID of ${zone}`,
  autoAccept: true,
  testHub: ({ subscriptionId }) => testHubZoneId(subscriptionId, zone),
  validate: () => v.resourceId('Microsoft.Network/privateDnsZones', zone),
  discover: async (discovery) =>
    (await discovery.privateDnsZones())
      .filter((found) => found.name === zone)
      .map((found) => ({ value: found.id, name: describe(found) })),
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
    discover: async (discovery) =>
      (await discovery.regions()).map((region) => ({
        value: region.name,
        name: `${region.displayName} (${region.name})${region.geography ? `, ${region.geography}` : ''}`,
      })),
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
    default: (a) => selfHostUrlFor(String(a.version ?? '')),
    validate: () => v.httpsUrl,
  },

  // ---- License ----
  {
    key: 'licenseKey',
    config: 'INGESTRO_LICENSE_KEY',
    section: 'License',
    kind: 'secret',
    message: 'DP license key for this environment',
    // Verified against Ingestro right away, so a wrong key or environment stops here.
    check: (value, a) =>
      checkLicense(
        value,
        String(a.version),
        a.selfHostDeploymentUrl as string | undefined,
      ),
  },

  // ---- Plans ----
  {
    key: 'functionPlanSku',
    config: 'functionPlanSku',
    section: 'App Service plans',
    // Not asked: the sizing of the reference deployment; override in the answers file.
    hidden: true,
    kind: 'select',
    message: 'Function App plan (Elastic Premium)',
    choices: ['EP1', 'EP2', 'EP3'].map((sku) => ({ value: sku, name: sku })),
    default: () => 'EP1',
  },
  {
    key: 'functionMaxInstances',
    config: 'functionMaxInstances',
    section: 'App Service plans',
    // Not asked: the sizing of the reference deployment; override in the answers file.
    hidden: true,
    kind: 'text',
    message: 'Function App maximum instances',
    default: () => '2',
    validate: () => (value) =>
      /^[1-9]\d?$/.test(value) ? undefined : 'A number from 1 to 99.',
  },
  {
    key: 'mappingPlanSku',
    config: 'mappingPlanSku',
    section: 'App Service plans',
    // Not asked: the sizing of the reference deployment; override in the answers file.
    hidden: true,
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
    // Not asked: the recommended layout; override in the answers file.
    hidden: true,
    kind: 'text',
    message:
      'Spoke VNet address space (must not overlap the hub, AVD or other spokes)',
    default: () => '10.20.0.0/16',
    validate: () => v.cidr,
  },
  {
    key: 'appSubnetPrefix',
    config: 'appSubnetPrefix',
    section: 'Spoke network',
    // Not asked: the recommended layout; override in the answers file.
    hidden: true,
    kind: 'text',
    message: 'App subnet (VNet integration, /26 or larger)',
    default: (a) => v.nthSubnet24(String(a.spokeAddressSpace), 1),
    validate: (a) => v.subnetIn(String(a.spokeAddressSpace), 26),
  },
  {
    key: 'peSubnetPrefix',
    config: 'peSubnetPrefix',
    section: 'Spoke network',
    // Not asked: the recommended layout; override in the answers file.
    hidden: true,
    kind: 'text',
    message: 'Private Endpoint subnet (/27 or larger)',
    default: (a) => v.nthSubnet24(String(a.spokeAddressSpace), 2),
    validate: (a) =>
      v.all(
        v.subnetIn(String(a.spokeAddressSpace), 27),
        v.notOverlapping({ 'the app subnet': a.appSubnetPrefix as string }),
      ),
  },
  {
    key: 'hubMode',
    config: 'wizardHubMode',
    section: 'Hub',
    kind: 'select',
    message: 'Hub network (firewall, DNS, App Gateway)',
    choices: [
      {
        value: 'existing',
        name: 'Use my existing hub: the network admin integrates it',
        description:
          'You enter the hub values (firewall IP, App Gateway subnet, Private DNS zones). At the end the wizard lists what the admin has to set up: peering, firewall rules and App Gateway.',
      },
      {
        value: 'test',
        name: 'Create a test hub for me (testing only, not for production)',
        description:
          'Deploys test/azure-docker-hub: an NVA instead of Azure Firewall, the six Private DNS zones, and a jump VM (SSH from your IP, test MongoDB). Peering and DNS are set up automatically; you reach the API through an SSH tunnel.',
      },
    ],
    default: () => 'existing',
  },
  {
    key: 'adminIp',
    config: 'wizardTestHubAdminIp',
    section: 'Hub',
    kind: 'text',
    message: 'Your public IP (allowed to SSH to the jump VM)',
    when: (a) => a.hubMode === 'test',
    validate: () => v.ipv4,
    discover: async () => {
      const ip = await detectPublicIp();

      return ip ? [{ value: ip, name: `${ip} (detected)` }] : [];
    },
  },
  {
    key: 'sshPublicKeyFile',
    config: 'wizardTestHubSshKey',
    section: 'Hub',
    kind: 'text',
    message: 'SSH public key for the jump VM',
    when: (a) => a.hubMode === 'test',
    discover: async () => {
      const keys = sshPublicKeys();
      const own = `${DEFAULT_SSH_KEY}.pub`;

      return [
        ...keys.map((file) => ({ value: file, name: file })),
        ...(keys.includes(own)
          ? []
          : [{ value: own, name: `${own} (generate a new key)` }]),
      ];
    },
  },
  {
    key: 'firewallPrivateIp',
    config: 'firewallPrivateIp',
    section: 'Hub',
    kind: 'text',
    message: 'Azure Firewall private IP in your hub (next hop for all egress)',
    default: () => '10.0.0.4',
    validate: (a) => v.ipOutside(String(a.spokeAddressSpace), 'the spoke'),
    testHub: () => TEST_HUB.firewallPrivateIp,
  },
  {
    key: 'appGatewaySubnetCidr',
    config: 'appGatewaySubnetCidr',
    section: 'Hub',
    kind: 'text',
    message:
      'App Gateway subnet in your hub (the only source allowed to reach the API)',
    default: () => '10.0.1.0/24',
    validate: (a) =>
      v.notOverlapping({ 'the spoke': a.spokeAddressSpace as string }),
    testHub: () => TEST_HUB.adminSourceCidr,
  },

  // ---- DNS ----
  {
    key: 'dnsMode',
    section: 'Hub',
    kind: 'select',
    message: 'How does the spoke resolve privatelink.* names?',
    choices: [
      {
        value: 'proxy',
        name: 'DNS proxy in the hub',
        description:
          'Your hub already resolves privatelink.* (e.g. Azure Firewall DNS proxy or a DNS forwarder). The spoke VNet uses its IP as DNS server; nothing is created in the hub.',
      },
      {
        value: 'link',
        name: 'No DNS proxy: link the zones to the spoke',
        description:
          'This deployment creates 6 virtual network links from the hub Private DNS zones to the spoke VNet. The zones themselves must already exist in the hub (they are not created). You need write access to the zones (Private DNS Zone Contributor), also when they are in another subscription.',
      },
    ],
    default: () => 'proxy',
    fromConfig: (read) =>
      read('linkPrivateDnsZonesToSpoke') === 'true'
        ? 'link'
        : read('dnsServers')
          ? 'proxy'
          : undefined,
    testHub: () => 'link',
  },
  {
    key: 'dnsServers',
    config: 'dnsServers',
    section: 'Hub',
    kind: 'list',
    message: 'DNS server IPs for the spoke (comma-separated)',
    when: (a) => a.dnsMode === 'proxy',
    // Azure Firewall is usually the hub's DNS proxy as well.
    default: (a) => a.firewallPrivateIp as string | undefined,
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
    // No App Gateway with the test hub: the jump VM tunnel reaches the Function App directly.
    testHub: () => undefined,
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
    testHub: () => 'direct',
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
    testHub: () => [TEST_HUB.adminSourceCidr],
  },

  // ---- Mapping LLM ----
  {
    key: 'mappingLlmProvider',
    config: 'mappingLlmProvider',
    section: 'Mapping module (AI)',
    kind: 'select',
    message: 'AI provider for column mapping',
    choices: [
      {
        value: 'AZURE',
        name: 'Azure OpenAI',
        description:
          'Recommended on Azure: reachable through a Private Endpoint, so no internet egress is needed.',
      },
      {
        value: 'BEDROCK',
        name: 'AWS Bedrock',
        description:
          'Needs egress from the spoke to bedrock-runtime.<region>.amazonaws.com and an AWS access key.',
      },
    ],
    default: () => 'AZURE',
  },
  {
    key: 'mappingAzureOpenaiEndpoint',
    config: 'mappingAzureOpenaiEndpoint',
    section: 'Mapping module (AI)',
    kind: 'text',
    message: 'Azure OpenAI endpoint, e.g. https://<resource>.openai.azure.com',
    when: (a) => a.mappingLlmProvider === 'AZURE',
    validate: () => v.httpsUrl,
  },
  {
    key: 'mappingAzureOpenaiDeploymentName',
    config: 'mappingAzureOpenaiDeploymentName',
    section: 'Mapping module (AI)',
    kind: 'text',
    message: 'Azure OpenAI deployment name',
    when: (a) => a.mappingLlmProvider === 'AZURE',
    default: () => 'gpt-4o-mini',
  },
  {
    key: 'mappingAzureOpenaiApiKey',
    config: 'mappingAzureOpenaiApiKey',
    section: 'Mapping module (AI)',
    kind: 'secret',
    message: 'Azure OpenAI API key',
    when: (a) => a.mappingLlmProvider === 'AZURE',
  },
  {
    key: 'mappingAwsBedrockRegion',
    config: 'mappingAwsBedrockRegion',
    section: 'Mapping module (AI)',
    kind: 'text',
    message: 'AWS Bedrock region',
    when: (a) => a.mappingLlmProvider === 'BEDROCK',
    default: () => 'eu-central-1',
    validate: () => (value) =>
      /^[a-z]{2}(-[a-z]+)+-\d$/.test(value)
        ? undefined
        : 'AWS region, e.g. eu-central-1.',
  },
  {
    key: 'mappingAwsBedrockModelId',
    config: 'mappingAwsBedrockModelId',
    section: 'Mapping module (AI)',
    kind: 'text',
    message: 'AWS Bedrock model ID',
    when: (a) => a.mappingLlmProvider === 'BEDROCK',
    default: () => 'anthropic.claude-3-haiku-20240307-v1:0',
  },
  {
    key: 'mappingAwsBedrockAccessKeyId',
    config: 'mappingAwsBedrockAccessKeyId',
    section: 'Mapping module (AI)',
    kind: 'secret',
    message: 'AWS access key ID (with bedrock:InvokeModel)',
    when: (a) => a.mappingLlmProvider === 'BEDROCK',
  },
  {
    key: 'mappingAwsBedrockSecretAccessKey',
    config: 'mappingAwsBedrockSecretAccessKey',
    section: 'Mapping module (AI)',
    kind: 'secret',
    message: 'AWS secret access key',
    when: (a) => a.mappingLlmProvider === 'BEDROCK',
  },

  // ---- Database ----
  {
    key: 'databaseMode',
    config: 'wizardDatabase',
    section: 'Database',
    kind: 'select',
    message: 'Where is MongoDB?',
    choices: [
      {
        value: 'atlas',
        name: 'MongoDB Atlas through a Private Endpoint',
        description:
          'Needs the Private Link Service ID of an Atlas endpoint service (Azure, same region). Two rounds: deploy, register the endpoint in Atlas, then switch to the private connection string. The wizard walks you through it.',
      },
      {
        value: 'testhub',
        name: 'Test MongoDB on the jump VM',
        description: 'No auth, for testing only. Ready right away.',
        when: (a) => a.hubMode === 'test',
      },
      {
        value: 'other',
        name: 'Another connection string',
        description:
          'Any MongoDB reachable from the spoke (through your firewall).',
      },
    ],
    default: (a) => (a.hubMode === 'test' ? 'testhub' : 'atlas'),
    fromConfig: (read) => {
      const uri = String(read('MONGO_CONNECTION_STRING') ?? '');
      if (read('ATLAS_PRIVATE_LINK_SERVICE_ID')) return 'atlas';
      if (uri === TEST_HUB.mongoConnectionString) return 'testhub';

      return uri ? 'other' : undefined;
    },
  },
  {
    key: 'atlasPrivateLinkServiceId',
    config: 'ATLAS_PRIVATE_LINK_SERVICE_ID',
    section: 'Database',
    kind: 'text',
    message:
      'Atlas Private Link Service resource ID (Atlas > Network Access > Private Endpoint > Microsoft Azure)',
    when: (a) => a.databaseMode === 'atlas',
    validate: () => v.resourceId('Microsoft.Network/privateLinkServices'),
  },
  {
    key: 'mongoConnectionString',
    config: 'MONGO_CONNECTION_STRING',
    section: 'Database',
    kind: 'secret',
    message: 'MongoDB connection string',
    auto: (a) => {
      if (a.databaseMode === 'testhub') return TEST_HUB.mongoConnectionString;
      // Atlas: the private string only exists once the endpoint is registered (second round).
      if (
        a.databaseMode === 'atlas' &&
        !isAtlasPrivate(a.mongoConnectionString)
      )
        return ATLAS_PENDING;

      return undefined;
    },
    validate: (a) =>
      a.databaseMode === 'atlas'
        ? v.all(v.mongoUri, (value) =>
            isAtlasPrivate(value)
              ? undefined
              : 'Use the private endpoint string (host contains -pl-).',
          )
        : v.mongoUri,
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
