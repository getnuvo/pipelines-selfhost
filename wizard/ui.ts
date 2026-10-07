import { BRAND, detectDarkBackground, foreground } from './theme';

const tty = process.stdout.isTTY && !process.env['NO_COLOR'];
const paint = (code: string) => (text: string) =>
  tty ? `\x1b[${code}m${text}\x1b[0m` : text;

export const bold = paint('1');
export const dim = paint('2');
export const green = paint('32');
export const yellow = paint('33');
export const red = paint('31');

// Brand color for the banner and headings; switched to the light variant on dark backgrounds.
let brandCode = foreground(BRAND.dark);
export const brand = (text: string) =>
  tty ? `\x1b[${brandCode}m${text}\x1b[0m` : text;

/** Pick the brand color for this terminal's background (call once, before any prompt). */
export const initTheme = async () => {
  if (!tty) return;
  brandCode = foreground(
    (await detectDarkBackground()) ? BRAND.dark : BRAND.light,
  );
};

export const heading = (text: string) =>
  console.log(`\n${bold(brand(`== ${text}`))}`);
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

// "INGESTRO" in the ANSI Shadow figlet font, one glyph per letter so the rows always line up.
const GLYPHS: Record<string, string[]> = {
  I: ['██╗', '██║', '██║', '██║', '██║', '╚═╝'],
  N: [
    '███╗   ██╗',
    '████╗  ██║',
    '██╔██╗ ██║',
    '██║╚██╗██║',
    '██║ ╚████║',
    '╚═╝  ╚═══╝',
  ],
  G: [
    ' ██████╗ ',
    '██╔════╝ ',
    '██║  ███╗',
    '██║   ██║',
    '╚██████╔╝',
    ' ╚═════╝ ',
  ],
  E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
  S: ['███████╗', '██╔════╝', '███████╗', '╚════██║', '███████║', '╚══════╝'],
  T: [
    '████████╗',
    '╚══██╔══╝',
    '   ██║   ',
    '   ██║   ',
    '   ██║   ',
    '   ╚═╝   ',
  ],
  R: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██║  ██║', '╚═╝  ╚═╝'],
  O: [
    ' ██████╗ ',
    '██╔═══██╗',
    '██║   ██║',
    '██║   ██║',
    '╚██████╔╝',
    ' ╚═════╝ ',
  ],
};

export const banner = (subtitle: string) => {
  const rows = GLYPHS['I'].map((_, row) =>
    [...'INGESTRO'].map((letter) => GLYPHS[letter][row]).join(''),
  );
  console.log(`\n${rows.map((row) => brand(`  ${row}`)).join('\n')}`);
  console.log(`  ${bold(subtitle)}\n`);
};
