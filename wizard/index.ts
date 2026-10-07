import { confirm, input, password, select } from '@inquirer/prompts';
import { parseArgs } from 'node:util';
import { loadAnswers } from './answers';
import * as azure from './azure';
import { collectAnswers } from './collect';
import * as pulumi from './pulumi';
import { derivedConfig, isActive, QUESTIONS, type Answers } from './questions';
import {
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

const USAGE = `Usage: ./deploy.sh [options]

Deploys Ingestro Pipelines on Azure (private network, provider azure-docker).
Re-running is safe: answers already in the stack config become the defaults.

Options:
  --answers <file>   Batch mode: take every answer from a YAML file, no prompts
                     (see deploy.answers.example.yaml). Secrets can be env:VAR_NAME.
  --stack <name>     Stack to deploy (otherwise asked, or stackName in the answers file)
  --preview-only     Write the config and run a preview, but deploy nothing
  --yes              Deploy without the final confirmation (required in batch mode)
  -h, --help         Show this help`;

const parse = () => {
  const { values } = parseArgs({
    options: {
      answers: { type: 'string' },
      stack: { type: 'string' },
      'preview-only': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  return values;
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

const ensurePassphrase = async (
  backendUrl: string | undefined,
  batch: boolean,
) => {
  const local = !backendUrl || backendUrl.startsWith('file://');
  if (
    !local ||
    process.env['PULUMI_CONFIG_PASSPHRASE'] !== undefined ||
    process.env['PULUMI_CONFIG_PASSPHRASE_FILE']
  )
    return;
  if (batch)
    throw new WizardError(
      'The Pulumi backend is local, so stack secrets need a passphrase: set PULUMI_CONFIG_PASSPHRASE or PULUMI_CONFIG_PASSPHRASE_FILE.',
      2,
    );
  process.env['PULUMI_CONFIG_PASSPHRASE'] = await password({
    message:
      'Passphrase for the stack secrets (local Pulumi backend; keep it, you need it for every later run)',
    mask: '*',
    validate: (text) =>
      text.length >= 8 ? true : 'Use at least 8 characters.',
  });
};

const chooseStack = async (batch: boolean, wanted?: string) => {
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
      { value: '', name: 'Create a new stack' },
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
    if (JSON.stringify(current ?? undefined) === JSON.stringify(value)) return;
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

const nextSteps = (outputs: Record<string, unknown>) => {
  const out = (outputs['azureDocker'] ?? {}) as Record<
    string,
    string | undefined
  >;
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
  heading('Hand over to the network team (App Gateway)');
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
  heading('Verify from inside the network');
  info(
    `  curl https://${out['functionAppHostname']}${out['healthProbePath']}   # {"data":{"message":"OK"}}`,
  );
  info(
    `  nslookup ${out['functionAppHostname']}   # ${out['functionAppPrivateEndpointIp']}`,
  );
  info(
    dim(
      '  The same URL returns 403 from outside the network. See docs/azure-docker/guide.md.',
    ),
  );
};

const main = async () => {
  const args = parse();
  if (args.help) return info(USAGE);
  const batch = args.answers !== undefined;
  const file = batch ? loadAnswers(args.answers!) : {};

  info(bold('Ingestro Pipelines — Azure private network deployment'));
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
  await ensurePassphrase(whoami.url, batch);

  const stackName = await chooseStack(
    batch,
    args.stack ?? (file['stackName'] as string | undefined),
  );
  const found = await pulumi.findStack(stackName);
  const existing = found ? await pulumi.readConfig(found) : {};
  ok(
    `Stack ${stackName}${found ? ' (existing config loaded)' : ' (new, created after the review)'}`,
  );

  const answers = await collectAnswers({ file, existing, batch });
  review(stackName, subscription, answers);
  await quotaReminder(answers, batch);

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

  heading('Preview');
  const summary = await pulumi.preview(stack);
  const counts = Object.entries(summary)
    .map(([op, count]) => `${op}: ${count}`)
    .join(', ');
  info(`\n${bold('Plan')}: ${counts || 'no changes'}`);
  if (args['preview-only']) return info(dim('Preview only: nothing deployed.'));

  const changesPlanned = Object.entries(summary).some(
    ([op, count]) => op !== 'same' && (count ?? 0) > 0,
  );
  if (!changesPlanned) return ok('Already up to date.');
  if (batch && !args.yes)
    throw new WizardError(
      'Batch mode deploys only with --yes. Preview finished, nothing deployed.',
      2,
    );
  if (
    !args.yes &&
    !(await confirm({ message: 'Deploy now (pulumi up)?', default: false }))
  )
    return info(dim('Nothing deployed. Run ./deploy.sh again to continue.'));

  heading('Deploy');
  const outputs = await pulumi.up(stack);
  nextSteps(
    Object.fromEntries(
      Object.entries(outputs).map(([key, output]) => [key, output.value]),
    ),
  );
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
