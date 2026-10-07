import { password } from '@inquirer/prompts';
import { promises as dns } from 'node:dns';
import { az } from './azure';
import { isAtlasPrivate } from './questions';
import { bold, dim, heading, info, ok, warn, WizardError } from './ui';
import { mongoUri } from './validate';

const POLL_SECONDS = 20;
const POLL_LIMIT_MINUTES = 30;

const sleep = (seconds: number) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/** Connection state of the Azure side; Atlas approves it once the endpoint is registered there. */
export const endpointState = (endpointId: string) =>
  az<string>(
    'network',
    'private-endpoint',
    'show',
    '--ids',
    endpointId,
    '--query',
    'manualPrivateLinkServiceConnections[0].privateLinkServiceConnectionState.status',
  ).catch(() => 'Unknown');

export const registerInstructions = (
  endpointId: string,
  endpointIp: string,
) => {
  heading('MongoDB Atlas: register the Private Endpoint');
  info(
    '  In Atlas: Network Access > Private Endpoint > Dedicated Cluster > your Azure endpoint service > Add Endpoint.',
  );
  info(
    `  Skip the ${bold('az network private-endpoint create')} command Atlas shows: the endpoint already exists.`,
  );
  info('  Enter these two values:\n');
  info(`  ${bold('Private Endpoint resource ID')}`);
  info(`  ${endpointId}\n`);
  info(`  ${bold('Private Endpoint IP address')}`);
  info(`  ${endpointIp}\n`);
};

export const waitForApproval = async (endpointId: string) => {
  const deadline = Date.now() + POLL_LIMIT_MINUTES * 60_000;
  let last = '';
  for (;;) {
    const state = await endpointState(endpointId);
    if (state === 'Approved') return ok('Atlas approved the Private Endpoint');
    if (state === 'Rejected' || state === 'Disconnected')
      throw new WizardError(
        `The Private Endpoint is ${state} in Atlas. Remove it there and add it again.`,
      );
    if (state !== last)
      info(
        dim(
          `  endpoint state: ${state}, waiting for Atlas (checks every ${POLL_SECONDS}s, Ctrl+C to stop and resume later)...`,
        ),
      );
    last = state;
    if (Date.now() > deadline)
      throw new WizardError(
        `Atlas has not approved the endpoint after ${POLL_LIMIT_MINUTES} minutes. Check it in Atlas, then run ./deploy.sh again to continue.`,
      );
    await sleep(POLL_SECONDS);
  }
};

export const askPrivateConnectionString = () =>
  password({
    message:
      'Atlas private connection string (Connect > Private Endpoint > Drivers, with the database user)',
    mask: '*',
    validate: (text) =>
      mongoUri(text) ??
      (isAtlasPrivate(text)
        ? true
        : 'Use the private endpoint string: its host contains -pl- (e.g. cluster-pl-0.abc.mongodb.net).'),
  });

/**
 * Atlas publishes the -pl- host names in public DNS, pointing at the endpoint's private IP,
 * so this machine can check them without being in the network.
 */
export const checkPrivateDns = async (uri: string, endpointIp: string) => {
  const host = /^mongodb\+srv:\/\/(?:[^@/]*@)?([^/?]+)/.exec(uri)?.[1];
  if (!host) return;
  try {
    const records = await dns.resolveSrv(`_mongodb._tcp.${host}`);
    const addresses = (
      await Promise.all(records.map((record) => dns.resolve4(record.name)))
    ).flat();
    if (
      addresses.length > 0 &&
      addresses.every((address) => address === endpointIp)
    )
      return ok(`${host} resolves to the Private Endpoint ${endpointIp}`);
    warn(
      `${host} resolves to ${[...new Set(addresses)].join(', ')}, not ${endpointIp}. Check the endpoint IP registered in Atlas.`,
    );
  } catch (err) {
    warn(
      `Could not resolve ${host} (${(err as Error).message}). Atlas may still be publishing the records.`,
    );
  }
};
