/** Ingestro navy, and the same hue lightened for dark terminal backgrounds. */
export const BRAND = { light: '#0D2737', dark: '#98C8E7' };

type Rgb = [number, number, number];

const hexToRgb = (hex: string): Rgb => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** WCAG relative luminance, 0 (black) to 1 (white), from linearised sRGB channels. */
export const luminance = (rgb: Rgb) => {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;

    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Above this, black text contrasts better than white (WCAG): a light background. */
const LIGHT_THRESHOLD = 0.179;

/**
 * OSC 11 reply, e.g. `\x1b]11;rgb:1e1e/1e1e/1e1e\x07`; channels may have 1–4 hex digits.
 * Only a complete reply (ending in BEL or ST, `\x1b\\`) counts: it can arrive split across reads.
 */
export const parseOsc11 = (reply: string): Rgb | undefined => {
  const match =
    /rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\x07|\x1b\\)/i.exec(
      reply,
    );
  if (!match) return undefined;

  return match
    .slice(1, 4)
    .map((hex) =>
      Math.round((parseInt(hex, 16) / (16 ** hex.length - 1)) * 255),
    ) as Rgb;
};

/** The 16 ANSI colors in xterm's default palette. */
const ANSI_PALETTE = [
  '#000000',
  '#cd0000',
  '#00cd00',
  '#cdcd00',
  '#0000ee',
  '#cd00cd',
  '#00cdcd',
  '#e5e5e5',
  '#7f7f7f',
  '#ff0000',
  '#00ff00',
  '#ffff00',
  '#5c5cff',
  '#ff00ff',
  '#00ffff',
  '#ffffff',
];

/** COLORFGBG="15;0": the last field is the background ANSI color (0–15). */
export const darkFromColorFgBg = (value?: string) => {
  const hex = ANSI_PALETTE[Number(value?.split(';').pop() || NaN)];
  if (!hex) return undefined;

  return luminance(hexToRgb(hex)) < LIGHT_THRESHOLD;
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
  if (rgb) return luminance(rgb) < LIGHT_THRESHOLD;

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
