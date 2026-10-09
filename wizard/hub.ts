import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { LocalWorkspace, type OutputMap } from '@pulumi/pulumi/automation';
import { WORK_DIR } from './pulumi';
import { dim, info, WizardError } from './ui';

const run = promisify(execFile);

/**
 * Test hub (test/azure-docker-hub): NVA instead of Azure Firewall, a jump VM with a test
 * MongoDB, and the six Private DNS zones. Its addresses and names are fixed in that program,
 * so the spoke config can be written (and previewed) before the hub exists.
 */
export const TEST_HUB = {
  dir: path.join(WORK_DIR, 'test', 'azure-docker-hub'),
  stack: 'test',
  resourceGroup: 'ingestro-test-hub-rg',
  /** Stands in for the App Gateway subnet and the browser subnets: the jump VM (10.29.2.0/24)
   * and the optional test App Gateway (10.29.1.0/24) both reach the spoke. */
  addressSpace: '10.29.0.0/16',
  firewallPrivateIp: '10.29.0.4',
  mongoConnectionString: 'mongodb://10.29.2.4:27017',
};

export const testHubZoneId = (subscriptionId: string, zone: string) =>
  `/subscriptions/${subscriptionId}/resourceGroups/${TEST_HUB.resourceGroup}/providers/Microsoft.Network/privateDnsZones/${zone}`;

/** Public IP of this machine, allowed to SSH to the jump VM. */
export const detectPublicIp = async () => {
  try {
    const response = await fetch('https://api.ipify.org', {
      signal: AbortSignal.timeout(5_000),
    });

    return response.ok ? (await response.text()).trim() : undefined;
  } catch {
    return undefined;
  }
};

const sshDir = path.join(homedir(), '.ssh');
export const DEFAULT_SSH_KEY = path.join(sshDir, 'ingestro-test-hub');

/** Public keys in ~/.ssh, plus the wizard's own key once it exists. */
export const sshPublicKeys = () => {
  try {
    return readdirSync(sshDir)
      .filter((name) => name.endsWith('.pub'))
      .map((name) => path.join(sshDir, name));
  } catch {
    return [];
  }
};

/** Read the public key; generate the wizard's key pair when that is the one chosen. */
export const loadSshPublicKey = async (file: string) => {
  if (!existsSync(file) && file === `${DEFAULT_SSH_KEY}.pub`) {
    info(dim(`  generating SSH key ${DEFAULT_SSH_KEY}...`));
    mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    await run('ssh-keygen', [
      '-t',
      'ed25519',
      '-N',
      '',
      '-C',
      'ingestro-test-hub',
      '-f',
      DEFAULT_SSH_KEY,
    ]);
  }
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (err) {
    throw new WizardError(
      `Cannot read SSH public key ${file}: ${(err as Error).message}`,
    );
  }
};

const write = (text: string) => process.stdout.write(text);

export const openTestHub = async (settings: {
  subscriptionId: string;
  location: string;
  adminIp: string;
  sshPublicKey: string;
  spokeAddressSpace: string;
  /** The deployed spoke VNet; without one the hub has no peering yet. */
  spokeVnetId?: string;
}) => {
  const stack = await LocalWorkspace.createOrSelectStack({
    stackName: TEST_HUB.stack,
    workDir: TEST_HUB.dir,
  });
  await stack.setAllConfig({
    // Same subscription as the spoke: its zone IDs point there.
    'azure-native:subscriptionId': { value: settings.subscriptionId },
    location: { value: settings.location },
    adminIp: { value: settings.adminIp },
    sshPublicKey: { value: settings.sshPublicKey },
    spokeAddressSpace: { value: settings.spokeAddressSpace },
  });
  // A stale spokeVnetId (spoke destroyed) would make the hub peer with a VNet that is gone.
  if (settings.spokeVnetId)
    await stack.setConfig('spokeVnetId', { value: settings.spokeVnetId });
  else await stack.removeConfig('spokeVnetId').catch(() => undefined);

  return stack;
};

export type HubStack = Awaited<ReturnType<typeof openTestHub>>;

export const previewHub = (stack: HubStack) =>
  stack
    .preview({ onOutput: write, color: 'always', diff: false })
    .then((result) => result.changeSummary);

export const upHub = (stack: HubStack): Promise<OutputMap> =>
  stack
    .up({ onOutput: write, color: 'always' })
    .then((result) => result.outputs);

/** Peering is created by the hub program once it knows the spoke VNet. */
export const peerHub = async (stack: HubStack, spokeVnetId: string) => {
  await stack.setConfig('spokeVnetId', { value: spokeVnetId });

  return upHub(stack);
};

/** Apps that started before the peering could not pull their image: restart them. */
export const restartApps = async (resourceGroup: string, apps: string[]) => {
  for (const app of apps)
    await run('az', [
      'webapp',
      'restart',
      '--resource-group',
      resourceGroup,
      '--name',
      app,
    ]);
};
