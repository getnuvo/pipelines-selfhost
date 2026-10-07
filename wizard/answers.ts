import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { QUESTIONS, type Answer, type Answers } from './questions';
import { WizardError } from './ui';

/** Keys the answers file may hold besides the questions. */
export const META_KEYS = [
  'stackName',
  'subscriptionId',
  'pulumiPassphraseFile',
];

// `env:NAME` keeps secrets out of the file.
const resolve = (value: string, key: string, errors: string[]) => {
  if (!value.startsWith('env:')) return value;
  const name = value.slice(4);
  const resolved = process.env[name];
  if (resolved === undefined)
    errors.push(`${key}: environment variable ${name} is not set.`);

  return resolved;
};

export const loadAnswers = (file: string): Answers => {
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new WizardError(`Cannot read ${file}: ${(err as Error).message}`, 2);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new WizardError(`${file} must be a YAML mapping of answers.`, 2);

  const known = new Set([...META_KEYS, ...QUESTIONS.map((q) => q.key)]);
  const errors: string[] = [];
  const answers: Answers = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) {
      errors.push(`${key}: unknown key (see deploy.answers.example.yaml).`);
      continue;
    }
    if (value === null || value === undefined) continue;
    let answer: Answer | undefined;
    if (Array.isArray(value)) {
      answer = value
        .map((item) => resolve(String(item), key, errors))
        .filter((item): item is string => item !== undefined);
    } else if (typeof value === 'object') {
      errors.push(`${key}: expected a value or a list.`);
    } else {
      answer = resolve(String(value), key, errors);
    }
    answers[key] = answer;
  }
  if (errors.length > 0)
    throw new WizardError(
      `${file} has problems:\n  - ${errors.join('\n  - ')}`,
      2,
    );

  return answers;
};
