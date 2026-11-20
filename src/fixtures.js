// Test signal generators. These exist so the hard cases are reproducible:
//
//  * `tailThenTransient` – a very quiet passage (around -90 dBFS) immediately
//    followed by a full-scale transient. Any gain policy that reacts to the
//    transient after the quiet part has been written will audibly move the
//    quiet part; the fixtures make that measurable.
//  * `extremes` – positive/negative full-scale, one code past either rail,
//    zeros, and non-finite values, laid out so sign handling, byte order and
//    saturation policy can be checked sample by sample.

export const SR = 48000;

/** Quiet sine at `quietDb`, then an impulsive full-scale burst after it. */
export function tailThenTransient({
  quietSeconds = 1.0,
  quietDb = -90,
  transientFrames = 48,
  afterSeconds = 0.25,
  sampleRate = SR,
  channels = 2,
  transientPeak = 1.0,
} = {}) {
  const quietN = Math.round(quietSeconds * sampleRate);
  const afterN = Math.round(afterSeconds * sampleRate);
  const total = quietN + transientFrames + afterN;
  const data = new Float64Array(total * channels);
  const quietAmp = Math.pow(10, quietDb / 20);
  let peakIndex = -1;
  for (let i = 0; i < total; i++) {
    let v;
    if (i < quietN) {
      // 1 kHz, alternating channel phase so stereo decorrelation is exercised.
      v = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * quietAmp;
    } else if (i < quietN + transientFrames) {
      const k = i - quietN;
      // A decaying impulse train: the first sample hits the ceiling exactly.
      const env = Math.exp(-k / 8);
      v = peakIndex < 0 ? transientPeak : Math.sin(k * 1.7) * transientPeak * env;
      if (peakIndex < 0) peakIndex = i;
    } else {
      v = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * quietAmp;
    }
    for (let c = 0; c < channels; c++) {
      data[i * channels + c] = c === 0 ? v : v * (c % 2 === 0 ? 1 : -1);
    }
  }
  return {
    samples: data,
    channels,
    sampleRate,
    peakFrame: peakIndex,
    quietFrames: quietN,
    transientFrames,
    meta: { kind: 'tail-then-transient', quietDb, transientPeak },
  };
}

/**
 * Extreme values with a known layout. Frames:
 *   0: +1.0, -1.0
 *   1: +1.0000001 (over), -1.0000001 (over)   -> saturation / clip accounting
 *   2: +0.9999999, -0.9999999                  -> near rails, rounding
 *   3: 0, 0
 *   4: +2^-23, -2^-23                          -> effective LSB probes
 *   5: NaN, Infinity
 *   6: -Infinity, -0
 */
export function extremes({ sampleRate = SR } = {}) {
  const rows = [
    [1, -1],
    [1.0000001, -1.0000001],
    [0.9999999, -0.9999999],
    [0, 0],
    [Math.pow(2, -23), -Math.pow(2, -23)],
    [NaN, Infinity],
    [-Infinity, -0],
  ];
  const data = new Float64Array(rows.length * 2);
  rows.forEach((r, i) => data.set(r, i * 2));
  return {
    samples: data,
    channels: 2,
    sampleRate,
    rows,
    meta: { kind: 'extremes' },
  };
}

/** Deterministic PRNG so fixtures are reproducible without a dependency. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
