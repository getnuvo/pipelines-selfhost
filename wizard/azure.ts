import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WizardError } from './ui';

const run = promisify(execFile);

export const az = async <T>(...args: string[]): Promise<T> => {
  try {
    const { stdout } = await run('az', [...args, '-o', 'json'], {
      maxBuffer: 32 * 1024 * 1024,
    });

    return JSON.parse(stdout) as T;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new WizardError(
      `az ${args.join(' ')} failed${stderr ? `:\n${stderr}` : '.'}`,
    );
  }
};

export interface Subscription {
  id: string;
  name: string;
  tenantId: string;
  isDefault: boolean;
  state: string;
  user?: { name: string };
}

export const currentAccount = async () => {
  try {
    return await az<Subscription>('account', 'show');
  } catch (err) {
    // Only a missing login gets the login hint; any other az failure is shown as is.
    if (!/az login/i.test((err as Error).message)) throw err;
    throw new WizardError(
      'Azure CLI is not logged in. Run `az login` (add `--tenant <tenant-id>` for a specific tenant) and start again.',
    );
  }
};

export const subscriptions = async (tenantId: string) =>
  (await az<Subscription[]>('account', 'list')).filter(
    (sub) => sub.tenantId === tenantId && sub.state === 'Enabled',
  );

// Resource providers the stack creates resources in.
export const REQUIRED_PROVIDERS = [
  'Microsoft.Web',
  'Microsoft.Network',
  'Microsoft.KeyVault',
  'Microsoft.Storage',
  'Microsoft.OperationalInsights',
  'Microsoft.Insights',
];

export const unregisteredProviders = async (subscriptionId: string) => {
  const states = await Promise.all(
    REQUIRED_PROVIDERS.map(async (namespace) => ({
      namespace,
      state: await az<string>(
        'provider',
        'show',
        '--namespace',
        namespace,
        '--subscription',
        subscriptionId,
        '--query',
        'registrationState',
      ),
    })),
  );

  return states.filter(({ state }) => state !== 'Registered');
};

export const registerProvider = (namespace: string, subscriptionId: string) =>
  run('az', [
    'provider',
    'register',
    '--namespace',
    namespace,
    '--subscription',
    subscriptionId,
    '--wait',
  ]);

export interface FoundResource {
  id: string;
  name: string;
  subscriptionId: string;
}

export interface Region {
  name: string;
  displayName: string;
  geography?: string;
}

const perSubscription = async <T>(
  subscriptionIds: string[],
  list: (subscriptionId: string) => Promise<T[]>,
) =>
  (
    await Promise.all(
      subscriptionIds.map((id) => list(id).catch(() => [] as T[])),
    )
  ).flat();

/** Looks across every enabled subscription in the tenant; the hub is often in another one. */
export const discovery = (
  subscriptionIds: string[],
  /** The spoke's subscription: regions are listed for it. */
  subscriptionId = subscriptionIds[0],
) => {
  let zones: Promise<FoundResource[]> | undefined;
  let regions: Promise<Region[]> | undefined;

  return {
    regions: () =>
      // `az account list-locations` has no --subscription (current subscription only): ask ARM.
      (regions ??= az<Region[]>(
        'rest',
        '--method',
        'get',
        '--url',
        `/subscriptions/${subscriptionId}/locations?api-version=2022-12-01`,
        '--query',
        "value[?metadata.regionType=='Physical'].{name: name, displayName: displayName, geography: metadata.geographyGroup}",
      ).then((list) =>
        list.sort((a, b) => a.displayName.localeCompare(b.displayName)),
      )),
    privateDnsZones: () =>
      (zones ??= perSubscription(subscriptionIds, async (subscriptionId) =>
        (
          await az<{ id: string; name: string }[]>(
            'network',
            'private-dns',
            'zone',
            'list',
            '--subscription',
            subscriptionId,
            '--query',
            "[?starts_with(name, 'privatelink.')].{id: id, name: name}",
          )
        ).map((zone) => ({ ...zone, subscriptionId })),
      )),
  };
};

export type Discovery = ReturnType<typeof discovery>;
