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

/**
 * Stereo fidelity fixture with a fully known layout. Every feature is placed at
 * an absolute frame the tests can point back to:
 *
 *   1. ramps that sweep to and from both rails (positive and negative extrema),
 *      so the codes around the extrema can be checked sample by sample;
 *   2. a low-level dual-channel passage that deliberately spans a block
 *      boundary (`blockFrames`), where a lost or duplicated sample would be the
 *      only visible defect;
 *   3. one known clip per channel: an over-full-scale half wave whose saturated
 *      frames are reported up front;
 *   4. a clip-free low-amplitude triangle wave, for the no-clip control input.
 */
export function fidelitySignal({
  sampleRate = SR,
  channels = 2,
  blockFrames = 1024,
  rampFrames = 64,
  lowLevelFrames = 2048,
  clipFrames = 64,
  triangleFrames = 256,
  lowLevelAmp = 1 / 32768,
} = {}) {
  const total = rampFrames + lowLevelFrames + clipFrames + triangleFrames;
  const data = new Float64Array(total * channels);
  const marks = {
    ramps: { start: 0, end: rampFrames },
    lowLevel: { start: rampFrames, end: rampFrames + lowLevelFrames },
    clip: { start: rampFrames + lowLevelFrames, end: rampFrames + lowLevelFrames + clipFrames },
    triangle: { start: rampFrames + lowLevelFrames + clipFrames, end: total },
    blockBoundary: blockFrames,
    lowLevelCrossesBlock: rampFrames < blockFrames && rampFrames + lowLevelFrames > blockFrames,
    clipFrames: [],
  };

  for (let i = 0; i < total; i++) {
    let l = 0;
    let r = 0;
    if (i < rampFrames) {
      // Up then down ramp covering -1..+1 on the left and the inverse on the
      // right, so both rails and both signs are exercised in order.
      const phase = i / (rampFrames - 1); // 0..1
      const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2; // 0..1..0
      l = tri * 2 - 1;
      r = 1 - tri * 2;
    } else if (i < rampFrames + lowLevelFrames) {
      // Quiet, slightly different per-channel levels; spans the block boundary.
      const k = i - rampFrames;
      l = (k % 2 ? 1 : -1) * lowLevelAmp;
      r = (k % 2 ? -1 : 1) * lowLevelAmp * 0.5;
    } else if (i < rampFrames + lowLevelFrames + clipFrames) {
      // Half sine whose peaks exceed the integer full scale by 25%; the centre
      // samples saturate and their exact frames are recorded as known clips.
      const k = i - (rampFrames + lowLevelFrames);
      const half = Math.sin((Math.PI * k) / (clipFrames - 1));
      l = half * 1.25;
      r = -half * 1.25;
      if (l > 1 || r < -1) marks.clipFrames.push(i);
    } else {
      // Clip-free low-amplitude triangle: peak stays well under one LSB at
      // 16-bit only for the lowest rows; amplitude is fixed below 0.5 so no
      // integer output can ever reach a rail at unity gain.
      const k = i - (rampFrames + lowLevelFrames + clipFrames);
      const phase = (k % 32) / 32;
      const tri = phase < 0.5 ? phase * 2 : 1 - (phase - 0.5) * 2;
      l = (tri - 0.5) * 0.25;
      r = (0.5 - tri) * 0.25;
    }
    data[i * channels] = l;
    if (channels > 1) data[i * channels + 1] = r;
    else data[i * channels] = (l + r) / 2;
  }

  return {
    samples: data,
    channels,
    sampleRate,
    totalFrames: total,
    marks,
    meta: { kind: 'fidelity-signal', blockFrames },
  };
}

/**
 * Negative half wave that crosses integer full scale: every negative lobe goes
 * past -1.0 while the positive side stays inside range. Used to prove the
 * independent saturation reader names the negative rail, its channel and the
 * exact time range — including when the over-range samples fall inside a final
 * partial block.
 */
export function overFullScaleNegative({
  sampleRate = SR,
  channels = 2,
  frames = 300,
  overshoot = 1.5,
  partialTailFrames = 7,
} = {}) {
  const data = new Float64Array(frames * channels);
  const overFrames = [];
  for (let i = 0; i < frames; i++) {
    const s = Math.sin((2 * Math.PI * i) / 48);
    const neg = s < 0 ? s * overshoot : s * 0.5;
    data[i * channels] = neg;
    if (channels > 1) data[i * channels + 1] = neg * 0.9;
    if (neg < -1) overFrames.push(i);
  }
  return {
    samples: data,
    channels,
    sampleRate,
    totalFrames: frames,
    overFrames,
    partialTailStart: frames - partialTailFrames,
    meta: { kind: 'over-full-scale-negative', overshoot },
  };
}

/**
 * Clip-free low-amplitude triangle wave. With unity gain no sample can reach
 * either rail at any supported integer width; a saturation report against this
 * input would itself be a defect.
 */
export function lowTriangle({ sampleRate = SR, channels = 2, frames = 512, amplitude = 0.125, period = 64 } = {}) {
  const data = new Float64Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    const phase = (i % period) / period;
    const tri = phase < 0.5 ? phase * 2 : 1 - (phase - 0.5) * 2;
    const v = (tri - 0.5) * 2 * amplitude;
    data[i * channels] = v;
    if (channels > 1) data[i * channels + 1] = -v;
  }
  return { samples: data, channels, sampleRate, totalFrames: frames, amplitude, meta: { kind: 'low-triangle' } };
}
