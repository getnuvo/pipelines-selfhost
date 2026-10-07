import * as path from 'node:path';
import {
  LocalWorkspace,
  type OpMap,
  type OutputMap,
  type Stack,
} from '@pulumi/pulumi/automation';
import { WizardError } from './ui';

export const WORK_DIR = path.resolve(__dirname, '..');
export const PROJECT = 'pipeline-self-host';

export type ConfigValue = string | string[];
/** Stack config without the project prefix; list/object values are parsed. */
export type StackConfig = Record<string, { value: unknown; secret: boolean }>;

export const workspace = () => LocalWorkspace.create({ workDir: WORK_DIR });

export const backend = async () => {
  try {
    return await (await workspace()).whoAmI();
  } catch {
    throw new WizardError(
      'Pulumi is not logged in. Run `pulumi login` (or `pulumi login --local` to keep state on this machine) and start again.',
    );
  }
};

export const stackNames = async () =>
  (await (await workspace()).listStacks()).map((stack) => stack.name);

/** The stack if it exists; a new stack is only created once the answers are valid. */
export const findStack = (stackName: string) =>
  LocalWorkspace.selectStack({ stackName, workDir: WORK_DIR }).catch(
    () => undefined,
  );

export const createStack = (stackName: string) =>
  LocalWorkspace.createStack({ stackName, workDir: WORK_DIR });

const parse = (value: string) => {
  if (/^[[{]/.test(value)) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }

  return value;
};

export const readConfig = async (stack: Stack): Promise<StackConfig> => {
  const all = await stack.getAllConfig();

  return Object.fromEntries(
    Object.entries(all).map(([key, entry]) => [
      key.startsWith(`${PROJECT}:`) ? key.slice(PROJECT.length + 1) : key,
      { value: parse(entry.value), secret: !!entry.secret },
    ]),
  );
};

/** `privateDnsZoneIds.blob` reads into objects; plain keys read as-is. */
export const configValue = (config: StackConfig, key: string): unknown => {
  const [root, child] = key.split('.', 2);
  const entry = config[root];
  if (!entry) return undefined;
  if (child === undefined) return entry.value;

  return (entry.value as Record<string, unknown> | undefined)?.[child];
};

export interface ConfigChange {
  key: string;
  value?: ConfigValue;
  secret?: boolean;
}

const qualify = (key: string) =>
  key.includes(':') ? key : `${PROJECT}:${key}`;

export const writeConfig = async (stack: Stack, changes: ConfigChange[]) => {
  for (const { key, value, secret } of changes) {
    if (value === undefined) {
      await stack
        .removeConfig(qualify(key), key.includes('.'))
        .catch(() => undefined);
    } else if (Array.isArray(value)) {
      // Rewrite lists as a whole so shorter lists don't keep old trailing items.
      await stack.removeConfig(qualify(key)).catch(() => undefined);
      for (const [index, item] of value.entries())
        await stack.setConfig(
          `${qualify(key)}[${index}]`,
          { value: item, secret },
          true,
        );
    } else {
      await stack.setConfig(qualify(key), { value, secret }, key.includes('.'));
    }
  }
};

const write = (text: string) => process.stdout.write(text);

export const preview = (stack: Stack): Promise<OpMap> =>
  stack
    .preview({ onOutput: write, color: 'always', diff: false })
    .then((result) => result.changeSummary);

export const up = (stack: Stack): Promise<OutputMap> =>
  stack
    .up({ onOutput: write, color: 'always' })
    .then((result) => result.outputs);

/** The deployed spoke VNet ID, when the stack has been deployed with that output. */
export const spokeVnetId = async (stack: Stack) => {
  const outputs = await stack.outputs().catch(() => ({}) as OutputMap);
  const docker = outputs['azureDocker']?.value as
    | { spokeVnetId?: string }
    | undefined;

  return docker?.spokeVnetId;
};
