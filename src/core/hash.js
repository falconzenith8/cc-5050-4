// Counter-based 32-bit mixing. Used for dither so that the value for a given
// (seed, frame, channel) never depends on how the input was blocked.
export function mix32(x) {
  x = x | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

const GOLDEN = 0x9e3779b9;
const TAP_A = 0x85ebca6b;
const TAP_B = 0xc2b2ae35;

/**
 * Uniform [0,1) derived from absolute frame index and channel index.
 * Stateless by construction: identical inputs always give identical output.
 */
export function uniform01(seed, frame, channel, tap) {
  let h = mix32((seed >>> 0) ^ 0x27d4eb2f);
  h = mix32(h ^ (frame >>> 0) ^ GOLDEN);
  h = mix32(h ^ Math.imul((frame / 4294967296) | 0, TAP_A));
  h = mix32(h ^ Math.imul((channel + 1) | 0, TAP_B));
  h = mix32(h ^ Math.imul(tap | 0, GOLDEN));
  // 24 high-quality bits are plenty for dither; scaling by 2^-24 keeps the
  // value strictly below 1 while staying exactly representable.
  return (h >>> 8) * 5.960464477539063e-8;
}

export function tpdf(seed, frame, channel) {
  const a = uniform01(seed, frame, channel, 0);
  const b = uniform01(seed, frame, channel, 1);
  return a - b; // triangular, peak +-1 LSB, RMS 0.408 LSB
}

export function rpdf(seed, frame, channel) {
  return uniform01(seed, frame, channel, 2) - 0.5;
}
