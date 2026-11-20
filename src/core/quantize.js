// Format-independent quantisation and dither.
//
// The dither value for (seed, absolute frame, channel) is computed from a
// counter-based hash. It therefore does not depend on how the caller blocks
// the input, on the gain, or on the number of channels processed per call.

import { tpdf, rpdf } from './hash.js';

export const DITHER_NONE = 'none';
export const DITHER_TPDF = 'tpdf';
export const DITHER_RPDF = 'rpdf';

export function validateDither(type) {
  if (type !== DITHER_NONE && type !== DITHER_TPDF && type !== DITHER_RPDF) {
    throw new Error(`unknown dither type: ${type}`);
  }
  return type;
}

export function ditherAmplitudeLsb(type) {
  if (type === DITHER_TPDF) return 1; // peak +-1 LSB
  if (type === DITHER_RPDF) return 0.5;
  return 0;
}

export function ditherValue(seed, frame, channel, type) {
  if (type === DITHER_TPDF) return tpdf(seed, frame, channel);
  if (type === DITHER_RPDF) return rpdf(seed, frame, channel);
  return 0;
}

function sanitize(v, stats, frame, channel) {
  if (Number.isFinite(v)) return v;
  if (Number.isNaN(v)) {
    stats.nan++;
    if (stats.firstNonFinite < 0) {
      stats.firstNonFinite = frame;
      stats.firstNonFiniteChannel = channel;
      stats.firstNonFiniteKind = 'nan';
    }
    return 0;
  }
  if (v > 0) {
    stats.posInf++;
    if (stats.firstNonFinite < 0) {
      stats.firstNonFinite = frame;
      stats.firstNonFiniteChannel = channel;
      stats.firstNonFiniteKind = '+inf';
    }
    return 1;
  }
  stats.negInf++;
  if (stats.firstNonFinite < 0) {
    stats.firstNonFinite = frame;
    stats.firstNonFiniteChannel = channel;
    stats.firstNonFiniteKind = '-inf';
  }
  return -1;
}

export class IntegerQuantizer {
  /**
   * @param {object} opts
   * @param {number} opts.bits target word length (8..32)
   * @param {number} opts.gain linear gain, frozen before the first write
   * @param {string} opts.dither none|tpdf|rpdf
   * @param {number} opts.seed uint32
   * @param {'saturate'|'fail'} [opts.overflow]
   * @param {'sanitize'|'fail'} [opts.nonFinite]
   */
  constructor({ bits, gain, dither = DITHER_TPDF, seed = 0, overflow = 'saturate', nonFinite = 'sanitize' }) {
    if (!(bits >= 8 && bits <= 32)) throw new RangeError('bits must be 8..32');
    if (!(gain > 0) || !Number.isFinite(gain)) throw new RangeError('gain must be finite and > 0');
    validateDither(dither);
    this.bits = bits;
    this.gain = gain;
    this.dither = dither;
    this.seed = seed >>> 0;
    this.overflow = overflow;
    this.nonFinite = nonFinite;
    this.scale = Math.pow(2, bits - 1);
    this.minCode = -this.scale;
    this.maxCode = this.scale - 1;
    this.ditherPeak = ditherAmplitudeLsb(dither);
    this.errorLimitLsb = 0.5 + this.ditherPeak + 1e-9;
    this.stats = {
      frames: 0,
      samples: 0,
      overloadPos: 0,
      overloadNeg: 0,
      fullScaleClampPos: 0,
      fullScaleClampNeg: 0,
      nan: 0,
      posInf: 0,
      negInf: 0,
      firstNonFinite: -1,
      firstNonFiniteChannel: -1,
      firstNonFiniteKind: null,
      firstOverload: -1,
      firstOverloadChannel: -1,
      firstOverloadSign: 0,
      firstClamp: -1,
      quantOutliers: 0,
      firstQuantOutlier: -1,
      firstQuantOutlierChannel: -1,
      maxQuantErrorLsb: 0,
      sumQuantErrorSq: 0,
      quantErrorCount: 0,
    };
  }

  /** Quantise interleaved float64 samples into interleaved int32 samples. */
  processBlock(input, startFrame, channels, out = new Int32Array(input.length)) {
    const { scale, maxCode, minCode, gain, dither, seed, stats } = this;
    const n = input.length / channels;
    for (let i = 0; i < n; i++) {
      const frame = startFrame + i;
      for (let c = 0; c < channels; c++) {
        const idx = i * channels + c;
        let x = input[idx];
        x = sanitize(x, stats, frame, c);
        if (!Number.isFinite(x)) {
          if (this.nonFinite === 'fail') throw new Error(`non-finite input at frame ${frame} ch ${c}`);
          x = 0;
        }
        const y = x * gain; // gain is handed to the quantiser here
        const overPos = y > 1;
        const overNeg = y < -1;
        if (overPos) {
          stats.overloadPos++;
          if (stats.firstOverload < 0) {
            stats.firstOverload = frame;
            stats.firstOverloadChannel = c;
            stats.firstOverloadSign = 1;
          }
        } else if (overNeg) {
          stats.overloadNeg++;
          if (stats.firstOverload < 0) {
            stats.firstOverload = frame;
            stats.firstOverloadChannel = c;
            stats.firstOverloadSign = -1;
          }
        }
        if ((overPos || overNeg) && this.overflow === 'fail') {
          throw new Error(`clipping at frame ${frame} ch ${c} (value ${y.toFixed(9)})`);
        }

        const d = dither === DITHER_NONE ? 0 : ditherValue(seed, frame, c, dither);
        const v = y * scale + d;
        let q = Math.floor(v + 0.5);
        let clamped = false;
        if (q > maxCode) {
          q = maxCode;
          clamped = true;
          if (!overPos) {
            stats.fullScaleClampPos++;
            if (stats.firstClamp < 0) stats.firstClamp = frame;
          }
        } else if (q < minCode) {
          q = minCode;
          clamped = true;
          if (!overNeg) {
            stats.fullScaleClampNeg++;
            if (stats.firstClamp < 0) stats.firstClamp = frame;
          }
        }
        out[idx] = q;

        const errLsb = q - y * scale;
        const ae = Math.abs(errLsb);
        if (ae > stats.maxQuantErrorLsb) stats.maxQuantErrorLsb = ae;
        if (!overPos && !overNeg && !clamped) {
          stats.sumQuantErrorSq += errLsb * errLsb;
          stats.quantErrorCount++;
          if (ae > this.errorLimitLsb) {
            stats.quantOutliers++;
            if (stats.firstQuantOutlier < 0) {
              stats.firstQuantOutlier = frame;
              stats.firstQuantOutlierChannel = c;
            }
          }
        } else if (ae > this.errorLimitLsb) {
          // Clipped samples legitimately have large error; counted separately.
        }
      }
    }
    stats.frames += n;
    stats.samples += input.length;
    return out;
  }

  get rmsQuantErrorLsb() {
    return this.stats.quantErrorCount > 0
      ? Math.sqrt(this.stats.sumQuantErrorSq / this.stats.quantErrorCount)
      : 0;
  }

  get effectiveBitsEstimate() {
    // Quantisation error RMS in LSB vs the ideal uniform quantiser (1/sqrt12).
    const rms = this.rmsQuantErrorLsb;
    if (rms <= 0) return this.bits;
    return this.bits - Math.log2(rms * Math.sqrt(12));
  }

  summary() {
    return {
      bits: this.bits,
      gain: this.gain,
      gainDb: 20 * Math.log10(this.gain),
      dither: this.dither,
      seed: this.seed,
      ...this.stats,
      rmsQuantErrorLsb: this.rmsQuantErrorLsb,
      effectiveBitsEstimate: this.effectiveBitsEstimate,
      errorLimitLsb: this.errorLimitLsb,
    };
  }
}

/** Quantise one scalar; used by tests and by unusual sample counts. */
export function quantizeScalar(x, frame, channel, opts) {
  const q = new IntegerQuantizer(opts);
  const out = q.processBlock(Float64Array.of(x), frame, 1);
  return { code: out[0], stats: q.stats };
}
