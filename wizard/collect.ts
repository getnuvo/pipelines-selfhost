import { input, password, select } from '@inquirer/prompts';
import { checkLicense } from './license';
import { configValue, type StackConfig } from './pulumi';
import {
  isActive,
  QUESTIONS,
  type Answer,
  type Answers,
  type Question,
} from './questions';
import { heading, warn, WizardError } from './ui';
import * as v from './validate';

interface Sources {
  /** Answers file (batch mode). */
  file: Answers;
  existing: StackConfig;
  batch: boolean;
}

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
  if (
    question.choices &&
    !question.choices.some((choice) => choice.value === answer)
  )
    return `One of: ${question.choices.map((choice) => choice.value).join(', ')}.`;

  return undefined;
};

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
  const validate = (answer: Answer | undefined) =>
    errorsFor(question, answer, answers) ?? true;
  switch (question.kind) {
    case 'select':
      return select({
        message: question.message,
        choices: question.choices ?? [],
        default: typeof current === 'string' ? current : undefined,
      });
    case 'secret': {
      const keep = current !== undefined;
      const value = await password({
        message: `${question.message}${keep ? ' (Enter keeps the current value)' : ''}`,
        mask: '*',
        validate: (text) => (keep && text === '' ? true : validate(text)),
      });

      return keep && value === '' ? current : value;
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

      return value === '' ? undefined : value;
    }
  }
};

export const collectAnswers = async ({
  file,
  existing,
  batch,
}: Sources): Promise<Answers> => {
  const answers: Answers = {};
  const problems: string[] = [];
  let section = '';

  for (const question of QUESTIONS) {
    if (!isActive(question, answers)) continue;
    const known = file[question.key] ?? fromStack(question, existing);
    let answer: Answer | undefined;

    if (question.hidden || batch) {
      answer = known ?? question.default?.(answers) ?? question.generate?.();
      const error = errorsFor(question, answer, answers);
      if (error) problems.push(`${question.key}: ${error}`);
    } else {
      if (question.section !== section) {
        section = question.section;
        heading(section);
      }
      answer = await ask(
        question,
        known ?? question.default?.(answers),
        answers,
      );
    }
    answers[question.key] = answer;

    // Check the license as soon as it is known, so a wrong key fails before anything else.
    if (question.key === 'licenseKey' && typeof answer === 'string' && answer) {
      let error = await checkLicense(
        answer,
        String(answers.version),
        answers.selfHostDeploymentUrl as string,
      );
      while (error && !batch) {
        warn(error);
        answer = await ask(question, undefined, answers);
        answers[question.key] = answer;
        error = await checkLicense(
          String(answer),
          String(answers.version),
          answers.selfHostDeploymentUrl as string,
        );
      }
      if (error) problems.push(`licenseKey: ${error}`);
    }
  }

  if (problems.length > 0)
    throw new WizardError(
      `The answers are incomplete or invalid:\n  - ${problems.join('\n  - ')}`,
      2,
    );

  return answers;
};
