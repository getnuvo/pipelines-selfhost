import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  azureNameParts,
  baseUrl,
  cidr,
  ipOutside,
  mongoUri,
  notOverlapping,
  nthSubnet24,
  notPlaceholder,
  origin,
  resourceId,
  subnetIn,
} from './validate';

const ok = undefined;

describe('cidr', () => {
  it('accepts network addresses only', () => {
    assert.equal(cidr('10.20.0.0/16'), ok);
    assert.match(cidr('10.20.1.0/16') ?? '', /network address/);
    assert.match(cidr('10.20.0.0') ?? '', /CIDR/);
    assert.match(cidr('300.1.1.0/24') ?? '', /CIDR/);
  });
});

describe('subnetIn', () => {
  const inSpoke = subnetIn('10.20.0.0/16', 28);

  it('requires the subnet inside the spoke', () => {
    assert.equal(inSpoke('10.20.1.0/24'), ok);
    assert.match(inSpoke('10.21.1.0/24') ?? '', /inside the spoke/);
  });

  it('rejects subnets smaller than the minimum', () => {
    assert.match(inSpoke('10.20.1.0/29') ?? '', /Too small/);
  });
});

describe('notOverlapping', () => {
  it('names the range it overlaps', () => {
    const check = notOverlapping({ 'app subnet': '10.20.1.0/24' });
    assert.equal(check('10.20.2.0/24'), ok);
    assert.match(check('10.20.0.0/23') ?? '', /app subnet/);
  });
});

describe('ipOutside', () => {
  it('rejects an address inside the range', () => {
    const check = ipOutside('10.20.0.0/16', 'the spoke');
    assert.equal(check('10.0.0.4'), ok);
    assert.match(check('10.20.0.4') ?? '', /the spoke/);
  });
});

describe('notPlaceholder', () => {
  it('rejects copied placeholders and stray spaces', () => {
    assert.equal(notPlaceholder('/subscriptions/x'), ok);
    assert.match(
      notPlaceholder('<PLS resource ID from Atlas>') ?? '',
      /placeholder/,
    );
    assert.match(notPlaceholder(' value') ?? '', /spaces/);
  });
});

describe('resourceId', () => {
  const zone = resourceId(
    'Microsoft.Network/privateDnsZones',
    'privatelink.blob.core.windows.net',
  );
  const id = (name: string) =>
    `/subscriptions/fcf687c4-ccd1-42c5-90dd-e0e453192f64/resourceGroups/hub-rg/providers/Microsoft.Network/privateDnsZones/${name}`;

  it('checks the provider type and zone name', () => {
    assert.equal(zone(id('privatelink.blob.core.windows.net')), ok);
    assert.match(zone(id('privatelink.file.core.windows.net')) ?? '', /blob/);
    assert.match(zone('/subscriptions/x/privateDnsZones/y') ?? '', /Expected/);
  });
});

describe('urls', () => {
  it('base URL is the host only', () => {
    assert.equal(baseUrl('https://ingestro.company.local'), ok);
    assert.match(
      baseUrl('https://ingestro.company.local/dp') ?? '',
      /host only/,
    );
    assert.match(baseUrl('http://ingestro.company.local') ?? '', /https/);
  });

  it('origin has no path', () => {
    assert.equal(origin('https://app.company.com'), ok);
    assert.match(origin('https://app.company.com/x') ?? '', /origin only/);
  });
});

describe('mongoUri', () => {
  it('accepts standard and SRV strings', () => {
    assert.equal(mongoUri('mongodb://10.0.0.1:27017'), ok);
    assert.equal(mongoUri('mongodb+srv://u:p@c-pl-0.x.mongodb.net/'), ok);
    assert.match(mongoUri('https://x') ?? '', /mongodb/);
  });
});

describe('azureNameParts', () => {
  it('keeps storage account and key vault names within 16 characters', () => {
    assert.equal(azureNameParts('ingestro', 'dev'), ok);
    assert.match(azureNameParts('ingestro', 'production') ?? '', /too long/);
    assert.match(azureNameParts('Ingestro', 'dev') ?? '', /lowercase/);
    assert.equal(azureNameParts('in-gest', 'dev-1'), ok);
    assert.match(azureNameParts('ingestro-', 'dev') ?? '', /single dashes/);
    assert.match(azureNameParts('ing', 'd--ev') ?? '', /single dashes/);
  });
});

describe('nthSubnet24', () => {
  it('suggests /24 subnets inside the spoke', () => {
    assert.equal(nthSubnet24('10.20.0.0/16', 1), '10.20.1.0/24');
    assert.equal(nthSubnet24('10.30.4.0/22', 2), '10.30.6.0/24');
    assert.equal(nthSubnet24('10.20.0.0/24', 1), undefined);
  });
});

describe('cubic review cases', () => {
  it('rejects host-less MongoDB URIs', () => {
    assert.match(mongoUri('mongodb:///') ?? '', /mongodb/);
    assert.match(mongoUri('mongodb+srv://user:pw@/') ?? '', /mongodb/);
    assert.equal(
      mongoUri('mongodb+srv://u:p%40w@c-pl-0.x.mongodb.net/?retryWrites=true'),
      undefined,
    );
  });

  it('rejects base URLs with a fragment, query or credentials', () => {
    assert.match(
      baseUrl('https://ingestro.company.local/#x') ?? '',
      /host only/,
    );
    assert.match(
      baseUrl('https://ingestro.company.local/?a=1') ?? '',
      /host only/,
    );
    assert.match(
      baseUrl('https://user@ingestro.company.local') ?? '',
      /host only/,
    );
    assert.equal(baseUrl('https://ingestro.company.local/'), undefined);
  });
});
