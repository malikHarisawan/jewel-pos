/**
 * Code 128 barcode encoder — bar widths only, no rendering.
 *
 * Pure and dependency-free so the same encoder can be unit-tested, drawn as SVG
 * in the renderer, and reused by a future label-printer path without pulling a
 * barcode library into an offline desktop build.
 *
 * Code 128 subset B covers the full printable ASCII range, which is what a tag
 * number needs (letters, digits, dashes). Subset C would pack digit pairs more
 * tightly, but a jeweller's tag is short and mixed, so B keeps it simple and
 * always correct.
 */

/** Bar/space widths for values 0-106, as published in the Code 128 spec. */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
  '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
  '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '211232', '211133',
];

const START_B = 104;
const STOP = '2331112';

/** Code 128B maps a printable ASCII character to value (charCode - 32). */
const MIN_CHAR = 32;
const MAX_CHAR = 126;

export function isEncodable(text: string): boolean {
  if (text.length === 0) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < MIN_CHAR || c > MAX_CHAR) return false;
  }
  return true;
}

/**
 * Encode `text` as an alternating run-length list of module widths, starting
 * with a BAR. So [2,1,2,...] means a 2-module bar, a 1-module space, and so on.
 *
 * Throws on a character Code 128B cannot carry, rather than silently dropping
 * it — a label that scans as the wrong tag is worse than no label.
 */
export function encodeCode128B(text: string): number[] {
  if (!isEncodable(text)) {
    throw new Error('Code 128 can only encode printable ASCII characters.');
  }

  const values: number[] = [START_B];
  for (let i = 0; i < text.length; i++) {
    values.push(text.charCodeAt(i) - MIN_CHAR);
  }

  // Checksum: start value plus each data value weighted by its position, mod 103.
  let sum = START_B;
  for (let i = 0; i < text.length; i++) {
    sum += (text.charCodeAt(i) - MIN_CHAR) * (i + 1);
  }
  values.push(sum % 103);

  const widths: number[] = [];
  for (const v of values) {
    for (const ch of PATTERNS[v]) widths.push(Number(ch));
  }
  for (const ch of STOP) widths.push(Number(ch));
  return widths;
}

export interface BarRect {
  x: number;
  width: number;
}

/**
 * Turn encoded widths into bar rectangles at `moduleWidth` units each.
 *
 * Only bars are returned; spaces are the gaps between them, which is what an
 * SVG or canvas renderer actually needs to draw.
 */
export function barcodeRects(text: string, moduleWidth = 1): { rects: BarRect[]; totalWidth: number } {
  const widths = encodeCode128B(text);
  const rects: BarRect[] = [];
  let x = 0;
  let isBar = true;
  for (const w of widths) {
    const width = w * moduleWidth;
    if (isBar) rects.push({ x, width });
    x += width;
    isBar = !isBar;
  }
  return { rects, totalWidth: x };
}
