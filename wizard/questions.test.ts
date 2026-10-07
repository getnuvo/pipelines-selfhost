import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { Discovery } from './azure';
import {
  ATLAS_PENDING,
  choicesFor,
  isAtlasPrivate,
  QUESTIONS,
} from './questions';

const question = (key: string) => {
  const found = QUESTIONS.find((q) => q.key === key);
  assert.ok(found, key);

  return found;
};

const SUB = 'fcf687c4-ccd1-42c5-90dd-e0e453192f64';
const zoneId = (rg: string, name: string) =>
  `/subscriptions/${SUB}/resourceGroups/${rg}/providers/Microsoft.Network/privateDnsZones/${name}`;

const fakeDiscovery = (): Discovery => ({
  regions: async () => [
    {
      name: 'germanywestcentral',
      displayName: 'Germany West Central',
      geography: 'Europe',
    },
    { name: 'westeurope', displayName: 'West Europe', geography: 'Europe' },
  ],
  privateDnsZones: async () => [
    {
      id: zoneId('hub-rg', 'privatelink.blob.core.windows.net'),
      name: 'privatelink.blob.core.windows.net',
      subscriptionId: SUB,
    },
    {
      id: zoneId('hub-rg', 'privatelink.file.core.windows.net'),
      name: 'privatelink.file.core.windows.net',
      subscriptionId: SUB,
    },
    {
      id: zoneId('other-rg', 'privatelink.blob.core.windows.net'),
      name: 'privatelink.blob.core.windows.net',
      subscriptionId: SUB,
    },
  ],
});

describe('private DNS zone discovery', () => {
  it('offers only zones with the matching name', async () => {
    const found = await question('privateDnsZone_blob').discover!(
      fakeDiscovery(),
      {},
    );
    assert.deepEqual(
      found.map((item) => item.value),
      [
        zoneId('hub-rg', 'privatelink.blob.core.windows.net'),
        zoneId('other-rg', 'privatelink.blob.core.windows.net'),
      ],
    );
    assert.match(found[0].name, /resource group hub-rg/);
  });

  it('finds nothing for a zone that does not exist', async () => {
    const found = await question('privateDnsZone_sites').discover!(
      fakeDiscovery(),
      {},
    );
    assert.equal(found.length, 0);
  });
});

describe('region', () => {
  it('lists regions by name with a readable label', async () => {
    const found = await question('location').discover!(fakeDiscovery(), {});
    assert.deepEqual(
      found.map((item) => item.value),
      ['germanywestcentral', 'westeurope'],
    );
    assert.equal(
      found[0].name,
      'Germany West Central (germanywestcentral), Europe',
    );
  });
});

describe('hub', () => {
  it('asks for the hub IPs and keeps the spoke layout hidden', () => {
    for (const key of ['firewallPrivateIp', 'appGatewaySubnetCidr'])
      assert.equal(question(key).hidden, undefined, key);
    for (const key of [
      'spokeAddressSpace',
      'appSubnetPrefix',
      'peSubnetPrefix',
    ])
      assert.equal(question(key).hidden, true, key);
  });

  it('defaults the DNS server to the firewall when the hub has a DNS proxy', () => {
    const dnsServers = question('dnsServers');
    assert.equal(dnsServers.when!({ dnsMode: 'link' }), false);
    assert.equal(
      dnsServers.default!({ firewallPrivateIp: '10.29.0.4' }),
      '10.29.0.4',
    );
  });
});

describe('mapping AI provider', () => {
  const azure = [
    'mappingAzureOpenaiEndpoint',
    'mappingAzureOpenaiDeploymentName',
    'mappingAzureOpenaiApiKey',
  ];
  const bedrock = [
    'mappingAwsBedrockRegion',
    'mappingAwsBedrockModelId',
    'mappingAwsBedrockAccessKeyId',
    'mappingAwsBedrockSecretAccessKey',
  ];

  it('asks only for the chosen provider', () => {
    for (const key of azure) {
      assert.equal(
        question(key).when!({ mappingLlmProvider: 'AZURE' }),
        true,
        key,
      );
      assert.equal(
        question(key).when!({ mappingLlmProvider: 'BEDROCK' }),
        false,
        key,
      );
    }
    for (const key of bedrock) {
      assert.equal(
        question(key).when!({ mappingLlmProvider: 'BEDROCK' }),
        true,
        key,
      );
      assert.equal(
        question(key).when!({ mappingLlmProvider: 'AZURE' }),
        false,
        key,
      );
    }
  });

  it('comes before the provider settings', () => {
    const order = QUESTIONS.map((q) => q.key);
    const provider = order.indexOf('mappingLlmProvider');
    for (const key of [...azure, ...bedrock])
      assert.ok(order.indexOf(key) > provider, key);
  });
});

describe('test hub', () => {
  const context = { subscriptionId: SUB };

  it('takes the hub-side values from the test hub', () => {
    assert.equal(question('firewallPrivateIp').testHub!(context), '10.29.0.4');
    assert.equal(
      question('appGatewaySubnetCidr').testHub!(context),
      '10.29.2.0/24',
    );
    assert.equal(question('dnsMode').testHub!(context), 'link');
    assert.equal(
      question('privateDnsZone_sites').testHub!(context),
      `/subscriptions/${SUB}/resourceGroups/ingestro-test-hub-rg/providers/Microsoft.Network/privateDnsZones/privatelink.azurewebsites.net`,
    );
    assert.deepEqual(question('blobClientCidrs').testHub!(context), [
      '10.29.2.0/24',
    ]);
  });

  it('asks for SSH access only with the test hub', () => {
    for (const key of ['adminIp', 'sshPublicKeyFile']) {
      assert.equal(question(key).when!({ hubMode: 'test' }), true, key);
      assert.equal(question(key).when!({ hubMode: 'existing' }), false, key);
    }
  });
});

describe('database', () => {
  const PRIVATE =
    'mongodb+srv://user:pw@pipelines-pl-0.hcrpls.mongodb.net/?retryWrites=true';
  const mongo = question('mongoConnectionString');

  it('recognises Atlas private endpoint strings', () => {
    assert.equal(isAtlasPrivate(PRIVATE), true);
    assert.equal(
      isAtlasPrivate('mongodb+srv://user:pw@pipelines.hcrpls.mongodb.net/'),
      false,
    );
    assert.equal(isAtlasPrivate('mongodb://10.29.2.4:27017'), false);
  });

  it('offers the jump VM database only with the test hub', () => {
    const values = (hubMode: string) =>
      choicesFor(question('databaseMode'), { hubMode }).map((c) => c.value);
    assert.deepEqual(values('test'), ['atlas', 'testhub', 'other']);
    assert.deepEqual(values('existing'), ['atlas', 'other']);
  });

  it('fills the connection string when it is known up front', () => {
    assert.equal(
      mongo.auto!({ databaseMode: 'testhub' }),
      'mongodb://10.29.2.4:27017',
    );
    assert.equal(mongo.auto!({ databaseMode: 'atlas' }), ATLAS_PENDING);
    assert.equal(
      mongo.auto!({ databaseMode: 'atlas', mongoConnectionString: PRIVATE }),
      undefined,
    );
    assert.equal(mongo.auto!({ databaseMode: 'other' }), undefined);
  });

  it('accepts only private strings for Atlas', () => {
    const check = mongo.validate!({ databaseMode: 'atlas' });
    assert.equal(check(PRIVATE), undefined);
    assert.match(check('mongodb+srv://u:p@c.x.mongodb.net/') ?? '', /-pl-/);
  });

  it('reads the database choice back from a stack', () => {
    const fromConfig = question('databaseMode').fromConfig!;
    const read = (config: Record<string, string>) => (key: string) =>
      config[key];
    assert.equal(
      fromConfig(
        read({
          ATLAS_PRIVATE_LINK_SERVICE_ID: '/x',
          MONGO_CONNECTION_STRING: PRIVATE,
        }),
      ),
      'atlas',
    );
    assert.equal(
      fromConfig(
        read({ MONGO_CONNECTION_STRING: 'mongodb://10.29.2.4:27017' }),
      ),
      'testhub',
    );
    assert.equal(
      fromConfig(read({ MONGO_CONNECTION_STRING: 'mongodb://db:27017' })),
      'other',
    );
  });
});
