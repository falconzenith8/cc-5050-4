// Peak protection and gain policy.
//
// Two modes, both of which freeze a single gain before any sample is written:
//
//  * 'scan'   – one analysis pass over the whole source establishes the peak
//               required to hit the target ceiling; that gain is then used for
//               every block. A loud transient in the last block cannot change
//               the gain already applied to the first.
//  * 'fixed'  – the operator specifies the gain. Overloads are counted and
//               attributed (frame/channel), and clipping is recorded in the
//               report rather than silently avoided.
//
// 'stream' only exists for callers that genuinely do not know the length; it
// keeps the gain pinned per configured chunk so a later peak cannot move it
// either, but the resulting level is whatever the first chunk allowed.

export const GAIN_SCAN = 'scan';
export const GAIN_FIXED = 'fixed';

export function validateGainPolicy(policy) {
  if (policy.mode !== GAIN_SCAN && policy.mode !== GAIN_FIXED) {
    throw new Error(`unknown gain mode: ${policy.mode}`);
  }
  return policy;
}

/**
 * Analyse absolute peak and true peak-ish sample max. `readBlock(startFrame,
 * frames)` must return interleaved Float64Array. Non-finite values are
 * reported but never propagate into the gain.
 */
export function analysePeak({ totalFrames, channels, readBlock, blockFrames = 65536, onProgress = null }) {
  let peak = 0;
  let peakFrame = -1;
  let peakChannel = -1;
  let peakSign = 0;
  let nonFinite = 0;
  let firstNonFinite = -1;
  let firstNonFiniteKind = null;
  let sumSq = 0;
  let count = 0;
  for (let start = 0; start < totalFrames; start += blockFrames) {
    const frames = Math.min(blockFrames, totalFrames - start);
    const block = readBlock(start, frames);
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        const v = block[i * channels + c];
        if (!Number.isFinite(v)) {
          nonFinite++;
          if (firstNonFinite < 0) {
            firstNonFinite = start + i;
            firstNonFiniteKind = Number.isNaN(v) ? 'nan' : v > 0 ? '+inf' : '-inf';
          }
          continue;
        }
        const a = Math.abs(v);
        if (a > peak) {
          peak = a;
          peakFrame = start + i;
          peakChannel = c;
          peakSign = v < 0 ? -1 : 1;
        }
        sumSq += v * v;
        count++;
      }
    }
    if (onProgress) onProgress(Math.min(1, (start + frames) / totalFrames));
  }
  const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
  return {
    peak,
    peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
    peakFrame,
    peakChannel,
    peakSign,
    rms,
    rmsDb: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
    nonFinite,
    firstNonFinite,
    firstNonFiniteKind,
  };
}

/**
 * Resolve the frozen gain decision. Returns a serialisable object; the
 * quantiser only ever sees `gain`.
 *
 * targetCeiling is a linear amplitude (e.g. 1 for 0 dBFS, 0.891 for -1 dBFS).
 * `headroomDb` is an alternate way to express it.
 */
export function decideGain({ analysis, policy, targetCeiling = 1, targetLufs = null, targetDb = null }) {
  const peak = analysis.peak;
  if (policy.mode === GAIN_FIXED) {
    // A linear gain can be supplied directly so a second pass (e.g. writing a
    // sibling container for a difference check) applies exactly the same
    // multiplication instead of round-tripping through dB.
    const linear = policy.gain;
    if (linear !== undefined) {
      if (!(linear > 0) || !Number.isFinite(linear)) throw new Error('fixed gain must be finite and > 0');
      return {
        mode: GAIN_FIXED,
        gain: linear,
        gainDb: 20 * Math.log10(linear),
        reason: policy.reason || 'operator-specified fixed gain (linear)',
        sourcePeak: peak,
        sourcePeakDb: analysis.peakDb,
        sourcePeakFrame: analysis.peakFrame,
        sourcePeakChannel: analysis.peakChannel,
        predictedCeiling: peak * linear,
        targetCeiling,
      };
    }
    const gainDb = policy.gainDb;
    if (!Number.isFinite(gainDb)) throw new Error('fixed gain requires a finite gainDb');
    return {
      mode: GAIN_FIXED,
      gain: Math.pow(10, gainDb / 20),
      gainDb,
      reason: 'operator-specified fixed gain',
      sourcePeak: peak,
      sourcePeakDb: analysis.peakDb,
      sourcePeakFrame: analysis.peakFrame,
      sourcePeakChannel: analysis.peakChannel,
      predictedCeiling: peak * Math.pow(10, gainDb / 20),
      targetCeiling,
    };
  }

  if (policy.mode === GAIN_SCAN) {
    const ceiling = targetDb !== null ? Math.pow(10, targetDb / 20) : targetCeiling;
    if (!(ceiling > 0)) throw new Error('target ceiling must be positive');
    if (!(peak > 0)) {
      return {
        mode: GAIN_SCAN,
        gain: 1,
        gainDb: 0,
        reason: 'silent source; gain unity',
        sourcePeak: peak,
        sourcePeakDb: analysis.peakDb,
        predictedCeiling: 0,
        targetCeiling: ceiling,
        targetLufs,
      };
    }
    const gain = ceiling / peak;
    return {
      mode: GAIN_SCAN,
      gain,
      gainDb: 20 * Math.log10(gain),
      reason: 'single pass over whole source, peak normalised to ceiling',
      sourcePeak: peak,
      sourcePeakDb: analysis.peakDb,
      sourcePeakFrame: analysis.peakFrame,
      sourcePeakChannel: analysis.peakChannel,
      predictedCeiling: ceiling,
      targetCeiling: ceiling,
      targetDb: 20 * Math.log10(ceiling),
      targetLufs,
    };
  }
  throw new Error(`unknown gain mode ${policy.mode}`);
}

/**
 * Guard against a late peak displacing an already-emitted gain. The conversion
 * driver calls this before writing each block; the first call freezes the
 * gain, later calls may only verify it.
 */
export class FrozenGain {
  constructor(decision) {
    if (!decision || !(decision.gain > 0)) throw new Error('FrozenGain needs a positive decision');
    this.decision = decision;
    this.frozen = false;
    this.appliedTo = 0;
    this.maxObserved = 0;
    this.lateOverloadFrames = 0;
  }

  apply(frameCount, observedPeak) {
    if (!this.frozen) this.frozen = true;
    if (observedPeak > this.maxObserved) this.maxObserved = observedPeak;
    if (observedPeak * this.decision.gain > 1.0000000001) this.lateOverloadFrames++;
    this.appliedTo += frameCount;
    return this.decision.gain;
  }

  summary() {
    return {
      mode: this.decision.mode,
      gain: this.decision.gain,
      gainDb: this.decision.gainDb,
      appliedTo: this.appliedTo,
      maxObservedPeak: this.maxObserved,
      lateOverloadBlocks: this.lateOverloadFrames,
    };
  }
}
