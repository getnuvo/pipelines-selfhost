// Input rules shared by the interactive prompts and the answers file.
// Each validator returns an error message, or undefined when the value is fine.

export type Validator = (value: string) => string | undefined;

const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export const parseIpv4 = (value: string): number | undefined => {
  const match = ipv4Pattern.exec(value);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return undefined;

  return octets.reduce((acc, octet) => acc * 256 + octet, 0);
};

export interface Cidr {
  start: number;
  end: number;
  prefix: number;
}

export const parseCidr = (value: string): Cidr | undefined => {
  const [ip, prefixText, ...rest] = value.split('/');
  if (rest.length > 0 || prefixText === undefined || !/^\d+$/.test(prefixText))
    return undefined;
  const address = parseIpv4(ip);
  const prefix = Number(prefixText);
  if (address === undefined || prefix > 32) return undefined;
  const size = 2 ** (32 - prefix);
  if (address % size !== 0) return undefined;

  return { start: address, end: address + size - 1, prefix };
};

export const cidrContains = (outer: Cidr, inner: Cidr) =>
  inner.start >= outer.start && inner.end <= outer.end;

export const cidrOverlaps = (a: Cidr, b: Cidr) =>
  a.start <= b.end && b.start <= a.end;

// Placeholders copied from docs (`<PLS resource ID>`) and stray whitespace end up in config.
export const notPlaceholder: Validator = (value) => {
  if (value !== value.trim()) return 'Remove the leading/trailing spaces.';
  if (/<[^>]*>/.test(value))
    return 'Replace the <placeholder> with the real value.';

  return undefined;
};

export const required: Validator = (value) =>
  value.trim() === '' ? 'Required.' : undefined;

export const ipv4: Validator = (value) =>
  parseIpv4(value) === undefined
    ? 'Expected an IPv4 address, e.g. 10.0.0.4.'
    : undefined;

export const cidr: Validator = (value) =>
  parseCidr(value) === undefined
    ? 'Expected a CIDR with a network address, e.g. 10.20.0.0/16.'
    : undefined;

export const subnetIn =
  (spoke: string, minimumSize: number): Validator =>
  (value) => {
    const subnet = parseCidr(value);
    const outer = parseCidr(spoke);
    if (!subnet) return cidr(value);
    if (outer && !cidrContains(outer, subnet))
      return `Must be inside the spoke address space ${spoke}.`;
    if (subnet.prefix > minimumSize)
      return `Too small: use /${minimumSize} or larger.`;

    return undefined;
  };

export const notOverlapping =
  (others: Record<string, string | undefined>): Validator =>
  (value) => {
    const range = parseCidr(value);
    if (!range) return cidr(value);
    for (const [label, other] of Object.entries(others)) {
      const otherRange = other ? parseCidr(other) : undefined;
      if (otherRange && cidrOverlaps(range, otherRange))
        return `Overlaps ${label} (${other}).`;
    }

    return undefined;
  };

export const ipOutside =
  (range: string, label: string): Validator =>
  (value) => {
    const address = parseIpv4(value);
    const outer = parseCidr(range);
    if (address === undefined) return ipv4(value);
    if (outer && address >= outer.start && address <= outer.end)
      return `Must not be inside ${label} (${range}).`;

    return undefined;
  };

export const httpsUrl: Validator = (value) => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return 'Use an https:// URL.';
  } catch {
    return 'Expected a URL, e.g. https://ingestro.company.local.';
  }

  return undefined;
};

// Embeddables append /dp/api/v1 themselves, so the base URL is the host only.
export const baseUrl: Validator = (value) => {
  const error = httpsUrl(value);
  if (error) return error;
  const { pathname, search } = new URL(value);
  if ((pathname !== '/' && pathname !== '') || search)
    return 'Use the host only (no path such as /dp).';

  return undefined;
};

export const origin: Validator = (value) => {
  const error = httpsUrl(value);
  if (error) return error;
  if (new URL(value).origin !== value.replace(/\/$/, ''))
    return 'Use an origin only, e.g. https://app.company.com.';

  return undefined;
};

export const resourceId =
  (providerType: string, nameSuffix?: string): Validator =>
  (value) => {
    const pattern = new RegExp(
      `^/subscriptions/[0-9a-f-]{36}/resourceGroups/[^/]+/providers/${providerType.replace('.', '\\.')}/([^/]+)$`,
      'i',
    );
    const match = pattern.exec(value);
    if (!match)
      return `Expected /subscriptions/<id>/resourceGroups/<rg>/providers/${providerType}/<name>.`;
    if (nameSuffix && match[1].toLowerCase() !== nameSuffix)
      return `Expected the ${nameSuffix} zone, got ${match[1]}.`;

    return undefined;
  };

export const mongoUri: Validator = (value) =>
  /^mongodb(\+srv)?:\/\/\S+$/.test(value)
    ? undefined
    : 'Expected mongodb:// or mongodb+srv://...';

// Storage account and Key Vault names are built from prefix + environment (see src/azure-docker.ts).
export const azureNameParts = (prefix: string, environment: string) => {
  if (!/^[a-z][a-z0-9-]*$/.test(prefix))
    return 'prefix: lowercase letters, digits and dashes, starting with a letter.';
  if (!/^[a-z][a-z0-9-]*$/.test(environment))
    return 'environment: lowercase letters, digits and dashes, starting with a letter.';
  const storageAccount = `${prefix}${environment}sa`.replace(/[^a-z0-9]/g, '');
  const keyVault = `${prefix}-${environment}-kv`;
  if (storageAccount.length > 16 || keyVault.length > 16)
    return `prefix + environment too long ("${storageAccount}", "${keyVault}" must be <= 16 characters).`;

  return undefined;
};

export const stackName: Validator = (value) =>
  /^[a-zA-Z0-9._-]+$/.test(value)
    ? undefined
    : 'Letters, digits, ".", "_" and "-" only, e.g. acme-dev.';

export const all =
  (...validators: Validator[]): Validator =>
  (value) => {
    for (const validator of validators) {
      const error = validator(value);
      if (error) return error;
    }

    return undefined;
  };
