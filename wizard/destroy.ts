import { confirm, input, password, select } from '@inquirer/prompts';
import { removeAtlasEndpoint, type AtlasCredentials } from './atlas-api';
import {
  LocalWorkspace,
  type OutputMap,
  type Stack,
} from '@pulumi/pulumi/automation';
import { TEST_HUB } from './hub';
import { configValue, type StackConfig } from './pulumi';
import { bold, dim, heading, info, ok, table, warn, WizardError } from './ui';

const write = (text: string) => process.stdout.write(text);
const sleep = (seconds: number) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

interface StateResource {
  type: string;
  urn: string;
  retainOnDelete?: boolean;
}

const resources = async (stack: Stack) =>
  (
    ((await stack.exportStack()).deployment?.resources ?? []) as StateResource[]
  ).filter((resource) => !resource.type.startsWith('pulumi:'));

/**
 * Stacks deployed before secrets were retained on delete try to delete each Key Vault secret
 * through the vault's private data plane (403). Mark them retained: they go with the vault.
 */
const retainKeyVaultSecrets = async (stack: Stack) => {
  const state = await stack.exportStack();
  const secrets = (
    (state.deployment?.resources ?? []) as StateResource[]
  ).filter(
    (resource) =>
      resource.type === 'azure-native:keyvault:Secret' &&
      !resource.retainOnDelete,
  );
  if (secrets.length === 0) return;
  for (const secret of secrets) secret.retainOnDelete = true;
  await stack.importStack(state);
  info(dim(`  ${secrets.length} Key Vault secret(s) will go with the vault`));
};

/** Azure removes zone links asynchronously; deleting the zone right after can return 409. */
const destroyWithRetry = async (stack: Stack, label: string) => {
  for (let attempt = 1; ; attempt++) {
    try {
      await stack.destroy({ onOutput: write, color: 'always' });

      return ok(`${label} destroyed`);
    } catch (err) {
      const transient = /CannotDeleteResource|nested resources exist|409/.test(
        (err as Error).message,
      );
      if (!transient || attempt >= 3) throw err;
      warn(
        `${label}: Azure is still removing dependent resources; retrying in 30s...`,
      );
      await sleep(30);
    }
  }
};

export const destroyDeployment = async (options: {
  stack: Stack;
  stackName: string;
  config: StackConfig;
  batch: boolean;
  yes: boolean;
  keepHub: boolean;
}) => {
  const { stack, stackName, config, batch, yes } = options;
  const spokeResources = await resources(stack);
  const testHub = configValue(config, 'wizardHubMode') === 'test';
  const hubStack =
    testHub && !options.keepHub
      ? await LocalWorkspace.selectStack({
          stackName: TEST_HUB.stack,
          workDir: TEST_HUB.dir,
        }).catch(() => undefined)
      : undefined;
  const hubResources = hubStack ? await resources(hubStack) : [];
  const atlas = configValue(config, 'ATLAS_PRIVATE_LINK_SERVICE_ID');
  const outputs = await stack.outputs().catch(() => ({}) as OutputMap);
  const atlasEndpointId = (
    outputs['azureDocker']?.value as
      | { atlasPrivateEndpointId?: string }
      | undefined
  )?.atlasPrivateEndpointId;
  let atlasHandled = false;

  heading('Destroy');
  table([
    ['Stack', `${stackName}: ${spokeResources.length} resource(s)`],
    ...(hubStack
      ? ([
          [
            'Test hub',
            `${TEST_HUB.resourceGroup}: ${hubResources.length} resource(s)`,
          ],
        ] as [string, string][])
      : []),
  ]);
  if (spokeResources.length === 0 && hubResources.length === 0) {
    ok('Nothing deployed.');
  } else {
    if (batch && !yes)
      throw new WizardError('Batch mode destroys only with --yes.', 2);
    if (!yes) {
      const typed = await input({
        message: `This deletes everything above and its data. Type the stack name (${stackName}) to confirm`,
      });
      if (typed !== stackName)
        throw new WizardError('Not confirmed: nothing destroyed.', 130);
    }

    // Atlas first: its endpoint record points at the Azure endpoint the spoke is about to delete.
    if (atlas && atlasEndpointId) {
      const credentials = await atlasCredentials(batch);
      if (credentials) {
        heading('MongoDB Atlas: remove the endpoint');
        const result = await removeAtlasEndpoint(
          credentials,
          String(atlas),
          atlasEndpointId,
        ).catch((err: Error) => {
          warn(`${err.message} Remove it in the Atlas UI.`);

          return undefined;
        });
        if (result) ok(`Atlas endpoint ${result}`);
        atlasHandled = result !== undefined;
      }
    }

    if (spokeResources.length > 0) {
      heading(`Destroy: ${stackName}`);
      await retainKeyVaultSecrets(stack);
      await destroyWithRetry(stack, stackName);
    }
    if (hubStack && hubResources.length > 0) {
      heading('Destroy: test hub');
      // The spoke VNet is gone, so the hub must not peer with it on a later deploy.
      await hubStack.removeConfig('spokeVnetId').catch(() => undefined);
      await destroyWithRetry(hubStack, 'Test hub');
    }
  }

  heading('Left to do by hand');
  if (atlas)
    info(
      atlasHandled
        ? `  ${bold('MongoDB Atlas')}: the endpoint service and the cluster stay; delete the cluster if it was only for this test.`
        : `  ${bold('MongoDB Atlas')}: remove the Private Endpoint from the endpoint service (Network Access > Private Endpoint), and the cluster if it was only for this test.`,
    );
  info(
    `  ${bold('Key Vault')}: kept soft-deleted for 90 days (no cost); a new deployment uses a new name.`,
  );
  if (testHub && options.keepHub)
    info(
      `  ${bold('Test hub')}: kept (--keep-hub). It costs money while it runs.`,
    );

  if (!batch && !yes) {
    const remove = await confirm({
      message: `Also remove stack ${stackName} and its saved settings? (keep them to deploy again later)`,
      default: false,
    });
    if (remove) {
      await stack.workspace.removeStack(stackName);
      ok(`Stack ${stackName} removed`);
    }
  }
};

/** Service account for the Atlas Admin API: env in batch mode, otherwise asked (optional). */
const atlasCredentials = async (
  batch: boolean,
): Promise<AtlasCredentials | undefined> => {
  const clientId = process.env['ATLAS_CLIENT_ID'];
  const clientSecret = process.env['ATLAS_CLIENT_SECRET'];
  if (clientId && clientSecret) return { clientId, clientSecret };
  if (batch) {
    warn(
      'Set ATLAS_CLIENT_ID / ATLAS_CLIENT_SECRET to remove the Atlas endpoint as well.',
    );

    return undefined;
  }
  const how = await select({
    message: 'Remove the Private Endpoint from MongoDB Atlas too?',
    choices: [
      {
        value: 'api',
        name: 'Yes, with an Atlas service account (client ID + secret)',
        description:
          'Atlas > Organization > Access Manager > Service Accounts; the account needs Project Owner on the project.',
      },
      { value: 'manual', name: "No, I'll remove it in the Atlas UI" },
    ],
  });
  if (how === 'manual') return undefined;

  return {
    clientId: await input({
      message: 'Service account client ID',
      validate: (text) => (text.trim() ? true : 'Required.'),
    }),
    clientSecret: await password({
      message: 'Service account client secret',
      mask: '*',
      validate: (text) => (text ? true : 'Required.'),
    }),
  };
};
