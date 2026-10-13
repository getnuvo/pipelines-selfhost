import { input, password, search, select } from '@inquirer/prompts';
import type { Discovery } from './azure';
import { configValue, type StackConfig } from './pulumi';
import {
  choicesFor,
  isActive,
  QUESTIONS,
  type Answer,
  type Answers,
  type Question,
} from './questions';
import { dim, heading, info, ok, WizardError } from './ui';
import * as v from './validate';

interface Sources {
  /** Answers file (batch mode). */
  file: Answers;
  existing: StackConfig;
  batch: boolean;
  discovery: Discovery;
  subscriptionId: string;
}

const MANUAL = '\u0000manual';

/** Offer what was found in Azure; the current value stays first even when it was not found. */
const pick = async (
  question: Question,
  current: Answer | undefined,
  found: { value: string; name: string }[],
  answers: Answers,
) => {
  const currentValue = typeof current === 'string' ? current : undefined;
  const choices = [
    ...(currentValue && !found.some((item) => item.value === currentValue)
      ? [{ value: currentValue, name: `${currentValue}  (current)` }]
      : []),
    ...found,
    { value: MANUAL, name: 'Enter another value' },
  ];
  // Long lists (e.g. Azure regions) get a type-to-filter prompt, with the current value on top.
  const choice =
    choices.length > 15
      ? await search({
          message: `${question.message} (type to filter)`,
          pageSize: 12,
          source: (term) => {
            const ordered = [
              ...choices.filter((item) => item.value === currentValue),
              ...choices.filter((item) => item.value !== currentValue),
            ];
            const needle = term?.toLowerCase().trim();

            return needle
              ? ordered.filter(
                  (item) =>
                    item.value === MANUAL ||
                    item.name.toLowerCase().includes(needle),
                )
              : ordered;
          },
        })
      : await select({
          message: question.message,
          choices,
          default: currentValue ?? found[0]?.value,
        });

  return choice === MANUAL ? ask(question, undefined, answers) : choice;
};

const fromStack = (
  question: Question,
  existing: StackConfig,
): Answer | undefined => {
  const read = (key: string) => {
    const value = configValue(existing, key);
    if (value === undefined || value === null) return undefined;

    return Array.isArray(value) ? value.map(String) : String(value);
  };
  if (question.config) return read(question.config);

  return question.fromConfig?.((key) => read(key));
};

/** Atlas copies connection strings with this placeholder for the user's password. */
export const DB_PASSWORD = '<db_password>';

/** Ask for the database password when the string still has Atlas's placeholder. */
export const fillDbPassword = async (uri: string) => {
  if (!uri.includes(DB_PASSWORD)) return uri;
  const secret = await password({
    message: 'Password of the database user (replaces <db_password>)',
    mask: '*',
    validate: (text) => (text ? true : 'Required.'),
  });

  // Special characters (@ : / ? # %) must be encoded inside the URI.
  return uri.replace(DB_PASSWORD, encodeURIComponent(secret));
};

const errorsFor = (
  question: Question,
  answer: Answer | undefined,
  answers: Answers,
) => {
  const empty =
    answer === undefined ||
    answer === '' ||
    (Array.isArray(answer) && answer.length === 0);
  if (empty) return question.optional ? undefined : 'Required.';
  const validator = v.all(
    v.notPlaceholder,
    question.validate?.(answers) ?? (() => undefined),
  );
  const items = Array.isArray(answer) ? answer : [answer];
  for (const item of items) {
    const error = validator(item);
    if (error) return Array.isArray(answer) ? `${item}: ${error}` : error;
  }
  const choices = choicesFor(question, answers);
  if (question.choices && !choices.some((choice) => choice.value === answer))
    return `One of: ${choices.map((choice) => choice.value).join(', ')}.`;

  return undefined;
};

/** `.../resourceGroups/hub-rg/.../zone` -> `resource group hub-rg` for progress lines. */
const shortId = (answer: Answer) =>
  typeof answer === 'string' && answer.startsWith('/subscriptions/')
    ? `resource group ${answer.split('/')[4]}`
    : String(answer);

const splitList = (text: string) =>
  text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const ask = async (
  question: Question,
  current: Answer | undefined,
  answers: Answers,
) => {
  // Inline: the prompt shows a spinner while checking and stays open until the value passes.
  const validate = async (answer: Answer | undefined) => {
    const error = errorsFor(question, answer, answers);
    if (error) return error;
    if (question.check && typeof answer === 'string' && answer)
      return (await question.check(answer, answers)) ?? true;

    return true;
  };
  switch (question.kind) {
    case 'select':
      return select({
        message: question.message,
        choices: choicesFor(question, answers),
        default: typeof current === 'string' ? current : undefined,
      });
    case 'secret': {
      const keep = current !== undefined;
      const value = await password({
        message: `${question.message}${keep ? ' (Enter keeps the current value)' : ''}`,
        mask: '*',
        // <db_password> is asked for right after, so it is not a leftover placeholder here.
        validate: (text) =>
          validate(
            keep && text === '' ? current : text.replace(DB_PASSWORD, 'x'),
          ),
      });

      return keep && value === '' ? current : fillDbPassword(value);
    }
    case 'list': {
      const value = await input({
        message: question.message,
        default: Array.isArray(current) ? current.join(', ') : current,
        validate: (text) => validate(splitList(text)),
      });

      return splitList(value);
    }
    default: {
      const value = await input({
        message: question.message,
        default: typeof current === 'string' ? current : undefined,
        validate: (text) => validate(text.trim() === '' ? undefined : text),
      });

      return value.trim() === '' ? undefined : value;
    }
  }
};

export const collectAnswers = async ({
  file,
  existing,
  batch,
  discovery,
  subscriptionId,
}: Sources): Promise<Answers> => {
  const answers: Answers = {};
  const problems: string[] = [];
  let section = '';

  for (const question of QUESTIONS) {
    if (!isActive(question, answers)) continue;
    // The current value counts as an answer for `auto` (e.g. an Atlas private string already set).
    const fixed = question.auto?.({
      ...answers,
      [question.key]: file[question.key] ?? fromStack(question, existing),
    });
    if (fixed !== undefined) {
      answers[question.key] = fixed;
      continue;
    }
    if (answers.hubMode === 'test' && question.testHub) {
      answers[question.key] = question.testHub({ subscriptionId });
      continue;
    }
    const known = file[question.key] ?? fromStack(question, existing);
    let answer: Answer | undefined;

    if (question.hidden || batch) {
      answer = known ?? question.default?.(answers) ?? question.generate?.();
      if (question.kind === 'list' && typeof answer === 'string')
        answer = splitList(answer);
      if (answer === undefined && question.discover) {
        const found = await question.discover(discovery, answers);
        if (found.length === 1) {
          answer = found[0].value;
          ok(`${question.key}: found ${found[0].name}`);
        } else if (found.length === 0 && !question.optional) {
          problems.push(
            `${question.key}: not found in the subscriptions you can see; set it in the answers file.`,
          );
          continue;
        } else if (found.length > 1) {
          problems.push(
            `${question.key}: ${found.length} candidates found, set one:\n      ${found.map((item) => item.value).join('\n      ')}`,
          );
          continue;
        }
      }
      const error =
        errorsFor(question, answer, answers) ??
        (question.check && typeof answer === 'string' && answer
          ? await question.check(answer, answers)
          : undefined);
      if (error) problems.push(`${question.key}: ${error}`);
    } else {
      if (question.section !== section) {
        section = question.section;
        heading(section);
      }
      const current = known ?? question.default?.(answers);
      if (
        question.autoAccept &&
        current !== undefined &&
        !errorsFor(question, current, answers)
      ) {
        answers[question.key] = current;
        ok(
          `${question.message.replace(/^Resource ID of /, '')}: ${shortId(current)}`,
        );
        continue;
      }
      const found = question.discover
        ? await question.discover(discovery, answers)
        : [];
      if (question.discover && found.length === 0)
        info(dim('  Nothing found in your subscriptions; enter it by hand.'));
      if (question.autoAccept && found.length === 1) {
        answers[question.key] = found[0].value;
        ok(
          `${question.message.replace(/^Resource ID of /, '')}: ${found[0].name}`,
        );
        continue;
      }
      answer =
        found.length > 0
          ? await pick(question, current, found, answers)
          : await ask(question, current, answers);
    }
    answers[question.key] = answer;
  }

  if (problems.length > 0)
    throw new WizardError(
      `The answers are incomplete or invalid:\n  - ${problems.join('\n  - ')}`,
      2,
    );

  return answers;
};
