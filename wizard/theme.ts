/** Ingestro navy, and the same hue lightened for dark terminal backgrounds. */
export const BRAND = { light: '#0D2737', dark: '#98C8E7' };

type Rgb = [number, number, number];

const hexToRgb = (hex: string): Rgb => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** Relative luminance, 0 (black) to 1 (white). */
export const luminance = ([r, g, b]: Rgb) =>
  (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** OSC 11 reply, e.g. `\x1b]11;rgb:1e1e/1e1e/1e1e\x07`; channels may have 1–4 hex digits. */
export const parseOsc11 = (reply: string): Rgb | undefined => {
  const match = /rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(
    reply,
  );
  if (!match) return undefined;

  return match
    .slice(1, 4)
    .map((hex) =>
      Math.round((parseInt(hex, 16) / (16 ** hex.length - 1)) * 255),
    ) as Rgb;
};

/** COLORFGBG="15;0": the last field is the background ANSI color; 7 and 15 are light. */
export const darkFromColorFgBg = (value?: string) => {
  const background = value?.split(';').pop();
  if (!background || !/^\d+$/.test(background)) return undefined;

  return !['7', '15'].includes(background);
};

/** Ask the terminal for its background color; undefined when it does not answer in time. */
const queryBackground = (timeoutMs = 200) =>
  new Promise<Rgb | undefined>((resolve) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY || !stdout.isTTY) return resolve(undefined);
    const wasRaw = stdin.isRaw;
    let reply = '';
    const finish = (rgb?: Rgb) => {
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(rgb);
    };
    const onData = (chunk: Buffer) => {
      reply += chunk.toString();
      const rgb = parseOsc11(reply);
      if (rgb) finish(rgb);
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdout.write('\x1b]11;?\x07');
    const timer = setTimeout(() => finish(), timeoutMs);
  });

/** Dark unless the terminal says otherwise: most developer terminals are dark. */
export const detectDarkBackground = async () => {
  const rgb = await queryBackground();
  if (rgb) return luminance(rgb) < 0.5;

  return darkFromColorFgBg(process.env['COLORFGBG']) ?? true;
};

const truecolor = /truecolor|24bit/i.test(process.env['COLORTERM'] ?? '');

/** SGR foreground code: 24-bit when supported, otherwise the nearest 256-color entry. */
export const foreground = (hex: string) => {
  const [r, g, b] = hexToRgb(hex);
  if (truecolor) return `38;2;${r};${g};${b}`;
  const level = (value: number) =>
    value < 48 ? 0 : value < 115 ? 1 : Math.floor((value - 35) / 40);

  return `38;5;${16 + 36 * level(r) + 6 * level(g) + level(b)}`;
};
