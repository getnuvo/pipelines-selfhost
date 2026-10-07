import { confirm, input, password, select } from '@inquirer/prompts';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { dim, info, ok, WizardError } from './ui';

const expandHome = (file: string) =>
  file === '~' || file.startsWith('~/')
    ? path.join(homedir(), file.slice(1))
    : path.resolve(file);

const readableKeyFile = (file: string) => {
  try {
    return readFileSync(file, 'utf8').trim() === ''
      ? `${file} is empty.`
      : undefined;
  } catch (err) {
    return `Cannot read ${file}: ${(err as Error).message}`;
  }
};

const useKeyFile = (file: string) => {
  process.env['PULUMI_CONFIG_PASSPHRASE_FILE'] = file;
  ok(`Stack secrets: key file ${file}`);
};

const createKeyFile = (file: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${randomBytes(32).toString('base64')}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  info(
    dim(
      `  Created ${file} (readable by you only). Back it up: without it the stack secrets cannot be decrypted.`,
    ),
  );
};

const OTHER = '\u0000other';
const GENERATE = '\u0000generate';
const KEY_DIR = path.join(homedir(), '.pulumi');

const keyFiles = () => {
  try {
    return readdirSync(KEY_DIR)
      .filter((name) => name.endsWith('.passphrase'))
      .map((name) => path.join(KEY_DIR, name));
  } catch {
    return [];
  }
};

export type PassphraseSource = 'none' | 'env' | 'answers' | 'prompt';

interface PassphraseOptions {
  backendUrl: string | undefined;
  batch: boolean;
  stackName: string;
  /** An existing stack can only be opened with the key it was created with: no "generate". */
  existingStack: boolean;
  keyFileAnswer?: string;
  /** Ask again after a wrong key (drops what the previous prompt set). */
  retry?: boolean;
}

const chooseKeyFile = async (stackName: string, existingStack: boolean) => {
  const found = keyFiles();
  const ownFile = path.join(KEY_DIR, `${stackName}.passphrase`);
  const canGenerate = !existingStack && !found.includes(ownFile);
  const choice = await select({
    message: existingStack
      ? `Key file stack ${stackName} was created with`
      : 'Key file for the new stack',
    choices: [
      ...found.map((file) => ({ value: file, name: file })),
      ...(canGenerate
        ? [{ value: GENERATE, name: `Generate a new key file: ${ownFile}` }]
        : []),
      { value: OTHER, name: 'Another path' },
    ],
    default: found.includes(ownFile)
      ? ownFile
      : canGenerate
        ? GENERATE
        : found[0],
  });
  if (choice === GENERATE) {
    createKeyFile(ownFile);

    return ownFile;
  }
  if (choice !== OTHER) return choice;

  const file = expandHome(
    await input({
      message: 'Key file path',
      validate: (text) => (text.trim() ? true : 'Required.'),
    }),
  );
  if (existsSync(file)) {
    const error = readableKeyFile(file);
    if (error) throw new WizardError(error);

    return file;
  }
  if (
    existingStack ||
    !(await confirm({
      message: `${file} does not exist. Generate a new random key file there?`,
      default: true,
    }))
  )
    throw new WizardError(
      `${file} does not exist${existingStack ? `; stack ${stackName} needs the key file it was created with` : ''}.`,
    );
  createKeyFile(file);

  return file;
};

/**
 * A local Pulumi backend encrypts stack secrets with a passphrase. Use one already in the
 * environment, the answers file's pulumiPassphraseFile, or ask: a key file (reused on every
 * run; generated for a new stack) or a passphrase typed now.
 */
export const ensurePassphrase = async ({
  backendUrl,
  batch,
  stackName,
  existingStack,
  keyFileAnswer,
  retry,
}: PassphraseOptions): Promise<PassphraseSource> => {
  const local = !backendUrl || backendUrl.startsWith('file://');
  if (!local) return 'none';
  if (retry) {
    delete process.env['PULUMI_CONFIG_PASSPHRASE'];
    delete process.env['PULUMI_CONFIG_PASSPHRASE_FILE'];
  } else if (
    process.env['PULUMI_CONFIG_PASSPHRASE'] !== undefined ||
    process.env['PULUMI_CONFIG_PASSPHRASE_FILE']
  ) {
    return 'env';
  }

  if (keyFileAnswer) {
    const file = expandHome(keyFileAnswer);
    const error = readableKeyFile(file);
    if (error) throw new WizardError(`pulumiPassphraseFile: ${error}`, 2);
    useKeyFile(file);

    return 'answers';
  }
  if (batch)
    throw new WizardError(
      'The Pulumi backend is local, so stack secrets need a passphrase: set pulumiPassphraseFile in the answers file, or PULUMI_CONFIG_PASSPHRASE / PULUMI_CONFIG_PASSPHRASE_FILE.',
      2,
    );

  const mode = await select({
    message: `Stack secrets are encrypted locally. Unlock ${stackName} with`,
    choices: [
      {
        value: 'file',
        name: existingStack
          ? 'A key file (passphrase file)'
          : 'A key file (passphrase file): kept on disk, reused on every run, can be generated now',
      },
      {
        value: 'typed',
        name: 'A passphrase I type now (needed again on every run)',
      },
    ],
  });

  if (mode === 'typed') {
    process.env['PULUMI_CONFIG_PASSPHRASE'] = await password({
      message: existingStack
        ? `Passphrase stack ${stackName} was created with`
        : 'New passphrase (keep it: every later run needs it)',
      mask: '*',
      validate: (text) =>
        text.length >= 8 ? true : 'Use at least 8 characters.',
    });
    ok('Stack secrets: typed passphrase');

    return 'prompt';
  }

  useKeyFile(await chooseKeyFile(stackName, existingStack));

  return 'prompt';
};

/** Reading an existing stack's config fails here when the passphrase does not match. */
export const wrongPassphrase = (err: unknown) =>
  /passphrase|decrypt/i.test((err as Error).message ?? '');
