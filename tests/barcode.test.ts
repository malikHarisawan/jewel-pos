import { describe, it, expect } from 'vitest';
import { encodeCode128B, barcodeRects, isEncodable } from '../src/shared/barcode/code128.js';

describe('isEncodable', () => {
  it('accepts the characters a jeweller puts on a tag', () => {
    expect(isEncodable('RING-001')).toBe(true);
    expect(isEncodable('22K/916 A1')).toBe(true);
  });

  it('rejects an empty tag', () => {
    expect(isEncodable('')).toBe(false);
  });

  it('rejects characters Code 128B cannot carry', () => {
    // Urdu label text is fine on the sticker, but it cannot go in the bars.
    expect(isEncodable('انگوٹھی')).toBe(false);
    expect(isEncodable('TAG\n1')).toBe(false);
  });
});

describe('encodeCode128B', () => {
  it('refuses to encode an unsupported character rather than dropping it', () => {
    // A label that scans as the wrong tag is worse than no label at all.
    expect(() => encodeCode128B('TAGé')).toThrow(/printable ASCII/);
  });

  /**
   * Known-good vector, read straight off the Code 128 pattern table for "A":
   *   START B (value 104) -> 211214
   *   'A'     (value 33)  -> 111323
   *   checksum (104 + 33x1) % 103 = 34 -> 131123
   *   STOP                -> 2331112
   * Concatenated, those run lengths are the encoder's whole output.
   */
  it('encodes a single character with the documented widths', () => {
    expect(encodeCode128B('A')).toEqual([
      2, 1, 1, 2, 1, 4, // START B  (104)
      1, 1, 1, 3, 2, 3, // 'A'      (33)
      1, 3, 1, 1, 2, 3, // checksum (34)
      2, 3, 3, 1, 1, 1, 2, // STOP
    ]);
  });

  it('computes the checksum over character positions, not just values', () => {
    // Same characters, different order -> different checksum, so a transposed
    // tag cannot scan as the original.
    const ab = encodeCode128B('AB');
    const ba = encodeCode128B('BA');
    expect(ab.slice(-13)).not.toEqual(ba.slice(-13));
  });

  it('produces the right structure for any tag', () => {
    const widths = encodeCode128B('RING-001');
    // start (6) + 8 chars x 6 + checksum (6) + stop (7)
    expect(widths).toHaveLength(6 + 8 * 6 + 6 + 7);
    // Every element is a legal module width.
    expect(widths.every((w) => w >= 1 && w <= 4)).toBe(true);
  });

  it('changes the checksum when the tag changes', () => {
    const a = encodeCode128B('RING-001');
    const b = encodeCode128B('RING-002');
    expect(a).not.toEqual(b);
  });

  it('is deterministic — the same tag always scans the same', () => {
    expect(encodeCode128B('CHAIN-42')).toEqual(encodeCode128B('CHAIN-42'));
  });
});

describe('barcodeRects', () => {
  it('returns only bars, and they never overlap', () => {
    const { rects, totalWidth } = barcodeRects('RING-001', 2);
    expect(rects.length).toBeGreaterThan(0);
    for (let i = 1; i < rects.length; i++) {
      // Each bar starts after the previous one ends — a space always separates.
      expect(rects[i].x).toBeGreaterThan(rects[i - 1].x + rects[i - 1].width - 0.001);
    }
    const last = rects[rects.length - 1];
    expect(last.x + last.width).toBeLessThanOrEqual(totalWidth);
  });

  it('scales with the module width', () => {
    const one = barcodeRects('RING-001', 1);
    const three = barcodeRects('RING-001', 3);
    expect(three.totalWidth).toBe(one.totalWidth * 3);
  });

  it('starts with a bar, as Code 128 requires', () => {
    expect(barcodeRects('A', 1).rects[0].x).toBe(0);
  });
});
