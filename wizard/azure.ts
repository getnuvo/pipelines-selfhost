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
  } catch {
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
