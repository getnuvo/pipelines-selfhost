import { confirm, input, select } from '@inquirer/prompts';
import { parseArgs } from 'node:util';
import { loadAnswers } from './answers';
import * as azure from './azure';
import { collectAnswers } from './collect';
import * as pulumi from './pulumi';
import {
  derivedConfig,
  isActive,
  isAtlasPrivate,
  QUESTIONS,
  type Answers,
} from './questions';
import * as atlas from './atlas';
import { destroyDeployment } from './destroy';
import * as hub from './hub';
import {
  ensurePassphrase,
  rememberedKeyFile,
  rememberKeyFile,
  wrongPassphrase,
} from './secrets';
import {
  banner,
  initTheme,
  bold,
  dim,
  fail,
  green,
  heading,
  info,
  ok,
  table,
  warn,
  WizardError,
} from './ui';
import { stackName as validStackName } from './validate';

const USAGE = `Usage: ./deploy.sh [destroy] [options]

Deploys Ingestro Pipelines on Azure (private network, provider azure-docker).
Re-running is safe: answers already in the stack config become the defaults.

Commands:
  (none)             Deploy or update a stack (wizard)
  destroy            Delete a stack's resources (and the test hub, if it uses one)

Options:
  --answers <file>   Batch mode: take every answer from a YAML file, no prompts
                     (see deploy.answers.example.yaml). Secrets can be env:VAR_NAME.
  --stack <name>     Stack to use (otherwise asked, or stackName in the answers file)
  --preview-only     Write the config and run a preview, but deploy nothing
  --yes              No confirmations (required to deploy in batch mode; destroy
                     with --stack runs without prompts)
  --keep-hub         destroy: keep the test hub
  -h, --help         Show this help

With a local Pulumi backend, stack secrets are encrypted with a key file or a
passphrase: the wizard asks which and remembers the key file per stack (or set
PULUMI_CONFIG_PASSPHRASE_FILE / PULUMI_CONFIG_PASSPHRASE, or pulumiPassphraseFile
in the answers file).`;

const COMMANDS = ['deploy', 'destroy'];

const parse = () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      answers: { type: 'string' },
      stack: { type: 'string' },
      'preview-only': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      'keep-hub': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const command = positionals[0] ?? 'deploy';
  if (!COMMANDS.includes(command) || positionals.length > 1)
    throw new WizardError(
      `Unknown command: ${positionals.join(' ')}\n\n${USAGE}`,
      2,
    );

  return { ...values, command };
};

const chooseSubscription = async (batch: boolean, wanted?: string) => {
  const account = await azure.currentAccount();
  const options = await azure.subscriptions(account.tenantId);
  if (wanted) {
    const match = options.find(
      (sub) => sub.id === wanted || sub.name === wanted,
    );
    if (!match)
      throw new WizardError(
        `Subscription ${wanted} is not available to ${account.user?.name}.`,
        2,
      );

    return match;
  }
  if (batch || options.length <= 1) return account;

  return select({
    message: 'Azure subscription for the spoke',
    choices: options.map((sub) => ({
      value: sub,
      name: `${sub.name} (${sub.id})`,
    })),
    default: options.find((sub) => sub.id === account.id),
  });
};

const checkProviders = async (subscriptionId: string, batch: boolean) => {
  const missing = await azure.unregisteredProviders(subscriptionId);
  if (missing.length === 0) return ok('Resource providers registered');
  const names = missing.map(({ namespace }) => namespace).join(', ');
  const commands = missing
    .map(
      ({ namespace }) =>
        `az provider register --namespace ${namespace} --subscription ${subscriptionId}`,
    )
    .join('\n  ');
  if (batch)
    throw new WizardError(
      `Resource providers not registered: ${names}. Run:\n  ${commands}`,
    );
  warn(`Resource providers not registered: ${names}`);
  if (
    !(await confirm({
      message: 'Register them now (az provider register)?',
      default: true,
    }))
  )
    throw new WizardError(`Register them first:\n  ${commands}`);
  for (const { namespace } of missing) {
    info(dim(`  registering ${namespace}...`));
    await azure.registerProvider(namespace, subscriptionId);
  }
  ok('Resource providers registered');
};

const chooseStack = async (
  batch: boolean,
  wanted?: string,
  allowNew = true,
) => {
  if (wanted) {
    const error = validStackName(wanted);
    if (error) throw new WizardError(`stackName: ${error}`, 2);

    return wanted;
  }
  if (batch)
    throw new WizardError(
      'Set stackName in the answers file or pass --stack.',
      2,
    );
  const existing = await pulumi.stackNames();
  const choice = await select({
    message: 'Stack (one per environment, e.g. acme-dev / acme-prod)',
    choices: [
      ...existing.map((name) => ({ value: name, name })),
      ...(allowNew ? [{ value: '', name: 'Create a new stack' }] : []),
    ],
  });
  if (choice) return choice;

  return input({
    message: 'New stack name',
    validate: (text) => validStackName(text) ?? true,
  });
};

const configChanges = (
  answers: Answers,
  existing: pulumi.StackConfig,
  subscriptionId: string,
) => {
  const changes: pulumi.ConfigChange[] = [];
  const add = (
    key: string,
    value: pulumi.ConfigValue | undefined,
    secret = false,
  ) => {
    const current = pulumi.configValue(existing, key);
    const storedAsSecret = existing[key.split('.')[0]]?.secret ?? false;
    // Same value is a no-op, unless a secret is still stored in plain text.
    if (
      JSON.stringify(current ?? undefined) === JSON.stringify(value) &&
      (!secret || storedAsSecret)
    )
      return;
    changes.push({ key, value, secret });
  };
  for (const question of QUESTIONS) {
    if (!question.config) continue;
    const value = isActive(question, answers)
      ? answers[question.key]
      : undefined;
    const empty =
      value === undefined ||
      value === '' ||
      (Array.isArray(value) && value.length === 0);
    add(question.config, empty ? undefined : value, question.kind === 'secret');
  }
  for (const [key, value] of Object.entries(derivedConfig(answers)))
    add(key, value);
  add('azure-native:subscriptionId', subscriptionId);

  return changes;
};

const review = (
  stackName: string,
  subscription: azure.Subscription,
  answers: Answers,
) => {
  heading('Review');
  const rows: [string, string][] = [
    ['stack', stackName],
    ['subscription', `${subscription.name} (${subscription.id})`],
  ];
  for (const question of QUESTIONS) {
    if (!isActive(question, answers)) continue;
    const value = answers[question.key];
    if (value === undefined || (Array.isArray(value) && value.length === 0))
      continue;
    rows.push([
      question.key,
      question.kind === 'secret'
        ? dim('set')
        : Array.isArray(value)
          ? value.join(', ')
          : value,
    ]);
  }
  table(rows);
};

const quotaReminder = async (answers: Answers, batch: boolean) => {
  const message =
    `App Service quota in ${answers.location}: ${answers.functionPlanSku} VMs >= ${answers.functionMaxInstances}, ` +
    `${answers.mappingPlanSku} VMs >= 1 (Azure portal > Quotas > App Service). New subscriptions often start at 0.`;
  if (batch) return warn(message);
  info(message);
  if (!(await confirm({ message: 'Is the quota in place?', default: true })))
    throw new WizardError(
      'Request the App Service quota first, then run ./deploy.sh again.',
    );
};

type SpokeOutputs = Record<string, string | undefined>;

const unwrap = (outputs: Record<string, { value: unknown }>) =>
  Object.fromEntries(
    Object.entries(outputs).map(([key, output]) => [key, output.value]),
  );

const deployedSummary = (out: SpokeOutputs) => {
  heading('Deployed');
  table([
    [
      'Function App',
      `${out['functionAppHostname']} -> ${out['functionAppPrivateEndpointIp']}`,
    ],
    [
      'Mapping',
      `${out['mappingAppHostname']} -> ${out['mappingPrivateEndpointIp']}`,
    ],
    ['Storage account', String(out['storageAccountName'])],
    ['Key Vault', String(out['keyVaultName'])],
    ['Resource group', String(out['resourceGroupName'])],
  ]);
};

/** Everything the network admin needs to connect the spoke to the existing hub. */
const handOver = (out: SpokeOutputs, answers: Answers) => {
  deployedSummary(out);
  heading('Hand over to the network admin');
  info(bold('1. Peering (hub <-> spoke)'));
  table([
    ['Spoke VNet', String(out['spokeVnetId'])],
    ['Address space', String(out['spokeAddressSpace'])],
    ['Settings', 'both directions; allow forwarded traffic on the hub side'],
  ]);
  info(bold('\n2. Azure Firewall'));
  table([
    [
      'Route',
      `the spoke's app subnet sends 0.0.0.0/0 to ${answers.firewallPrivateIp} (created by this deployment)`,
    ],
    [
      'Allow',
      `${out['spokeAddressSpace']} -> api-gateway.ingestro.com, Docker Hub (registry-1.docker.io, auth.docker.io, production.cloudflare.docker.com) on 443`,
    ],
    [
      'Also',
      'the AI provider endpoint and your pipeline data sources; full list: docs/azure-docker/guide.md#firewall-rules',
    ],
  ]);
  info(bold('\n3. DNS'));
  info(
    answers.dnsMode === 'link'
      ? '  Done by this deployment: the hub Private DNS zones are linked to the spoke VNet.'
      : `  The spoke uses ${String(answers.dnsServers)} as DNS server: it must resolve the privatelink.* zones (the Private Endpoint records are already in them).`,
  );
  info(bold('\n4. App Gateway'));
  table([
    ['Backend pool', String(out['functionAppHostname'])],
    [
      'Backend settings',
      `HTTPS 443, host header ${out['functionAppHostname']}`,
    ],
    ['Health probe', `GET ${out['healthProbePath']} -> 200`],
    ['Path rules', '/dp/* -> Function App; everything else 404'],
    [
      'Optional /blob/*',
      `strip /blob -> ${out['storageAccountName']}.blob.core.windows.net (HTTPS, host header)`,
    ],
  ]);
  heading('Verify from inside the network (after the peering)');
  info(
    `  curl https://${out['functionAppHostname']}${out['healthProbePath']}   # {"data":{"message":"OK"}}`,
  );
  info(
    `  nslookup ${out['functionAppHostname']}   # ${out['functionAppPrivateEndpointIp']}`,
  );
  info(
    dim(
      '  The apps pull their images once egress works: restart them after the peering and firewall rules are in place.',
    ),
  );
};

const testHubSteps = (
  out: SpokeOutputs,
  hub: Record<string, unknown>,
  sshKeyFile: string,
  stackName: string,
) => {
  deployedSummary(out);
  const privateKey = sshKeyFile.replace(/\.pub$/, '');
  heading('Try it (test hub)');
  info('  1. Open a tunnel through the jump VM (keep it running):');
  info(`     ssh -i ${privateKey} -N -D 1080 ingestro@${hub['jumpPublicIp']}`);
  info('  2. Start a browser that uses it:');
  info(
    '     open -na "Google Chrome" --args --user-data-dir=/tmp/chrome-ingestro --proxy-server="socks5://localhost:1080"',
  );
  info(
    `  3. Base URL for the dashboard / embeddables: https://${out['functionAppHostname']}`,
  );
  info(
    `     Health: https://${out['functionAppHostname']}${out['healthProbePath']}`,
  );
  info(
    dim(
      '  The test hub costs money while it runs. Remove the spoke first, then the hub:',
    ),
  );
  info(
    dim(
      `     pulumi destroy -s ${stackName}   then   (cd test/azure-docker-hub && pulumi destroy -s test)`,
    ),
  );
};

/** Unlock the stack's secrets (remembered key file, or ask, with retry) and read its config. */
const unlockStack = async ({
  stackName,
  found,
  backendUrl,
  batch,
  keyFileAnswer,
}: {
  stackName: string;
  found: Awaited<ReturnType<typeof pulumi.findStack>>;
  backendUrl: string | undefined;
  batch: boolean;
  keyFileAnswer?: string;
}) => {
  const passphrase = {
    backendUrl,
    batch,
    stackName,
    existingStack: found !== undefined,
    keyFileAnswer,
    rememberedKeyFile: rememberedKeyFile(stackName),
  };
  const source = await ensurePassphrase(passphrase);
  let existing: pulumi.StackConfig = {};
  for (let attempt = 1; found; attempt++) {
    try {
      existing = await pulumi.readConfig(found);
      break;
    } catch (err) {
      if (!wrongPassphrase(err)) throw err;
      const message = `Cannot decrypt the secrets of stack ${stackName}: the passphrase or key file is not the one it was created with.`;
      if (source !== 'prompt' || attempt >= 3)
        throw new WizardError(message, 2);
      warn(`${message} Try again.`);
      await ensurePassphrase({ ...passphrase, retry: true });
    }
  }
  ok(
    `Stack ${stackName}${found ? ' (existing config loaded)' : ' (new, created after the review)'}`,
  );
  rememberKeyFile(stackName);

  return existing;
};

const destroyCommand = async (args: ReturnType<typeof parse>) => {
  // --yes with --stack: no prompts at all.
  const batch = args.yes && args.stack !== undefined;
  heading('Preflight');
  const account = await azure.currentAccount();
  ok(
    `Azure: ${account.user?.name ?? 'logged in'}, subscription ${account.name}`,
  );
  const whoami = await pulumi.backend();
  ok(`Pulumi: ${whoami.user} @ ${whoami.url ?? 'backend'}`);
  const stackName = await chooseStack(batch, args.stack, false);
  const found = await pulumi.findStack(stackName);
  if (!found) throw new WizardError(`Stack ${stackName} does not exist.`, 2);
  const config = await unlockStack({
    stackName,
    found,
    backendUrl: whoami.url,
    batch,
  });
  await destroyDeployment({
    stack: found,
    stackName,
    config,
    batch,
    yes: args.yes ?? false,
    keepHub: args['keep-hub'] ?? false,
  });
  info(`\n${green('Done.')}`);
};

const main = async () => {
  const args = parse();
  if (args.help) return info(USAGE);
  if (args.command === 'destroy') {
    await initTheme();
    banner('Pipelines self-host · Azure private network');

    return destroyCommand(args);
  }
  const batch = args.answers !== undefined;
  const file = batch ? loadAnswers(args.answers!) : {};

  await initTheme();
  banner('Pipelines self-host · Azure private network');
  heading('Preflight');
  const subscription = await chooseSubscription(
    batch,
    file['subscriptionId'] as string | undefined,
  );
  ok(
    `Azure: ${subscription.user?.name ?? 'logged in'}, subscription ${subscription.name}`,
  );
  await checkProviders(subscription.id, batch);
  const whoami = await pulumi.backend();
  ok(`Pulumi: ${whoami.user} @ ${whoami.url ?? 'backend'}`);
  const stackName = await chooseStack(
    batch,
    args.stack ?? (file['stackName'] as string | undefined),
  );
  const found = await pulumi.findStack(stackName);
  const existing = await unlockStack({
    stackName,
    found,
    backendUrl: whoami.url,
    batch,
    keyFileAnswer: file['pulumiPassphraseFile'] as string | undefined,
  });

  const discovery = azure.discovery(
    (await azure.subscriptions(subscription.tenantId)).map((sub) => sub.id),
    subscription.id,
  );
  const sources = {
    file,
    existing,
    batch,
    discovery,
    subscriptionId: subscription.id,
  };
  // A complete saved config can be resumed without answering everything again.
  const saved =
    found && !batch
      ? await collectAnswers({ ...sources, batch: true }).catch(() => undefined)
      : undefined;
  const resume =
    saved &&
    (await select({
      message: `Saved settings found for ${stackName}`,
      choices: [
        {
          value: true,
          name: 'Resume with the saved settings (continue where you stopped)',
        },
        { value: false, name: 'Review and edit the settings' },
      ],
    }));
  const answers = resume ? saved : await collectAnswers(sources);
  // Laptops change networks: keep the jump VM's SSH rule on this machine's current IP.
  if (answers.hubMode === 'test') {
    const current = await hub.detectPublicIp();
    if (current && current !== answers.adminIp) {
      const message = `Your public IP changed: the jump VM allows SSH from ${answers.adminIp}, you are on ${current}.`;
      if (batch) warn(`${message} Set adminIp to update it.`);
      else if (
        await confirm({
          message: `${message} Allow ${current} instead?`,
          default: true,
        })
      )
        answers.adminIp = current;
    }
  }
  review(stackName, subscription, answers);
  // Only worth a question for a new stack; a deployed one already has the quota.
  await quotaReminder(answers, batch || found !== undefined);

  const changes = configChanges(answers, existing, subscription.id);
  if (
    !batch &&
    changes.length > 0 &&
    !(await confirm({
      message: `Save ${changes.length} config change(s) to stack ${stackName}?`,
      default: true,
    }))
  )
    throw new WizardError('Nothing saved.', 130);
  const stack = found ?? (await pulumi.createStack(stackName));
  await pulumi.writeConfig(stack, changes);
  ok(
    changes.length > 0
      ? `Saved ${changes.length} config change(s)`
      : 'Config unchanged',
  );

  // The test hub is configured (and previewed) together with the spoke, deployed first.
  const sshKeyFile = String(answers.sshPublicKeyFile ?? '');
  const hubStack =
    answers.hubMode === 'test'
      ? await hub.openTestHub({
          subscriptionId: subscription.id,
          location: String(answers.location),
          adminIp: String(answers.adminIp),
          sshPublicKey: await hub.loadSshPublicKey(sshKeyFile),
          spokeAddressSpace: String(answers.spokeAddressSpace),
          spokeVnetId: found ? await pulumi.spokeVnetId(found) : undefined,
        })
      : undefined;

  const plan = (summary: Record<string, number | undefined>) =>
    Object.entries(summary)
      .map(([op, count]) => `${op}: ${count}`)
      .join(', ') || 'no changes';
  const hasChanges = (summary: Record<string, number | undefined>) =>
    Object.entries(summary).some(
      ([op, count]) => op !== 'same' && (count ?? 0) > 0,
    );

  let hubChanges = false;
  if (hubStack) {
    heading('Preview: test hub');
    const hubSummary = await hub.previewHub(hubStack);
    hubChanges = hasChanges(hubSummary);
    info(`\n${bold('Test hub plan')}: ${plan(hubSummary)}`);
  }
  heading('Preview: Ingestro Pipelines');
  const summary = await pulumi.preview(stack);
  info(`\n${bold('Plan')}: ${plan(summary)}`);
  if (args['preview-only']) return info(dim('Preview only: nothing deployed.'));

  const atlasPending =
    answers.databaseMode === 'atlas' &&
    !isAtlasPrivate(answers.mongoConnectionString);
  let out: SpokeOutputs;
  let hubOutputs: Record<string, unknown> = {};

  if (!hasChanges(summary) && !hubChanges) {
    ok('Already up to date.');
    if (!atlasPending) return;
    // Resuming the Atlas second round: the endpoint already exists.
    out = unwrap(await stack.outputs())['azureDocker'] as SpokeOutputs;
  } else {
    if (batch && !args.yes)
      throw new WizardError(
        'Batch mode deploys only with --yes. Preview finished, nothing deployed.',
        2,
      );
    if (
      !args.yes &&
      !(await confirm({
        message: hubStack
          ? 'Deploy the test hub and Ingestro Pipelines now (pulumi up)?'
          : 'Deploy now (pulumi up)?',
        default: false,
      }))
    )
      return info(dim('Nothing deployed. Run ./deploy.sh again to continue.'));

    if (hubStack) {
      heading('Deploy: test hub');
      hubOutputs = unwrap(await hub.upHub(hubStack));
    }
    heading('Deploy: Ingestro Pipelines');
    out = unwrap(await pulumi.up(stack))['azureDocker'] as SpokeOutputs;

    if (hubStack) {
      heading('Peering the test hub with the spoke');
      hubOutputs = unwrap(
        await hub.peerHub(hubStack, String(out['spokeVnetId'])),
      );
      info(
        dim(
          '  restarting the apps so they pull their images through the hub...',
        ),
      );
      await hub.restartApps(String(out['resourceGroupName']), [
        String(out['functionAppName']),
        String(out['mappingAppHostname']).split('.')[0],
      ]);
    }
  }

  if (answers.databaseMode === 'atlas') {
    const endpointId = String(out['atlasPrivateEndpointId']);
    const endpointIp = String(out['atlasPrivateEndpointIp']);
    let uri = String(answers.mongoConnectionString);
    if (atlasPending) {
      await atlas.registerInstructions(
        endpointId,
        endpointIp,
        String(answers.location),
      );
      if (batch)
        throw new WizardError(
          'Atlas: register the endpoint above, then set mongoConnectionString to the private connection string (host with -pl-) and run again.',
          3,
        );
      await atlas.waitForApproval(endpointId);
      uri = await atlas.askPrivateConnectionString();
      await pulumi.writeConfig(stack, [
        { key: 'MONGO_CONNECTION_STRING', value: uri, secret: true },
      ]);
      heading('Deploy: Atlas private connection string');
      out = unwrap(await pulumi.up(stack))['azureDocker'] as SpokeOutputs;
    }
    await atlas.checkPrivateDns(uri, endpointIp);
  }

  // Nothing deployed this run (resumed): read the hub outputs instead.
  if (hubStack && Object.keys(hubOutputs).length === 0)
    hubOutputs = unwrap(await hubStack.outputs());
  if (hubStack) testHubSteps(out, hubOutputs, sshKeyFile, stackName);
  else handOver(out, answers);
  info(`\n${green('Done.')}`);
};

main().catch((err: Error) => {
  if (err.name === 'ExitPromptError') {
    info(dim('\nCancelled.'));
    process.exit(130);
  }
  fail(err.message);
  process.exit(err instanceof WizardError ? err.exitCode : 1);
});
