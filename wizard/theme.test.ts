import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { BRAND, darkFromColorFgBg, luminance, parseOsc11 } from './theme';

describe('background detection', () => {
  it('parses OSC 11 replies with 2 and 4 hex digits per channel', () => {
    assert.deepEqual(
      parseOsc11('\x1b]11;rgb:1e1e/1e1e/1e1e\x07'),
      [30, 30, 30],
    );
    assert.deepEqual(parseOsc11('\x1b]11;rgb:ff/ff/ff\x1b\\'), [255, 255, 255]);
    assert.equal(parseOsc11('garbage'), undefined);
  });

  it('treats a low luminance background as dark', () => {
    assert.ok(luminance([30, 30, 30]) < 0.179);
    assert.ok(luminance([250, 250, 250]) >= 0.179);
  });

  it('reads COLORFGBG', () => {
    assert.equal(darkFromColorFgBg('15;0'), true);
    assert.equal(darkFromColorFgBg('0;15'), false);
    assert.equal(darkFromColorFgBg('0;default;7'), false);
    assert.equal(darkFromColorFgBg(undefined), undefined);
  });

  it('keeps the brand colors readable on their backgrounds', () => {
    const rgb = (hex: string) =>
      [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [
        number,
        number,
        number,
      ];
    assert.ok(luminance(rgb(BRAND.light)) < 0.25, 'navy for light backgrounds');
    assert.ok(
      luminance(rgb(BRAND.dark)) > 0.4,
      'light tint for dark backgrounds',
    );
  });
});
