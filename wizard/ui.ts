const tty = process.stdout.isTTY && !process.env['NO_COLOR'];
const paint = (code: string) => (text: string) =>
  tty ? `\x1b[${code}m${text}\x1b[0m` : text;

export const bold = paint('1');
export const dim = paint('2');
export const green = paint('32');
export const yellow = paint('33');
export const red = paint('31');
export const cyan = paint('36');

export const heading = (text: string) =>
  console.log(`\n${bold(cyan(`== ${text}`))}`);
export const info = (text: string) => console.log(text);
export const ok = (text: string) => console.log(`${green('✓')} ${text}`);
export const warn = (text: string) => console.log(`${yellow('!')} ${text}`);
export const fail = (text: string) => console.error(`${red('✗')} ${text}`);

export const table = (rows: [string, string][]) => {
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows)
    console.log(`  ${label.padEnd(width)}  ${value}`);
};

/** Exit codes: 2 = invalid answers, 130 = cancelled. */
export class WizardError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}
