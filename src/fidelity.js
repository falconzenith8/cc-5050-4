// Fidelity analysis for the sampling/conversion window.
//
// Everything here is independent of the conversion report:
//
//   * IndependentReader re-parses the produced container from its bytes and
//     exposes per-sample integer codes plus a saturation scan that names the
//     channel and absolute time range of every rail-stuck sample.
//   * pointwiseQuantizationCheck recomputes each code straight from the float
//     input with the standalone integer quantization formula, so a wrong gain,
//     a swapped channel or a reset dither all surface as pointwise failures.
//   * errorDistribution gives per-channel histograms of the quantization error
//     in LSB; the two injected faults (channel swap, dither reset) have
//     distinguishable signatures on that map.

import { parseWavHeader, decodeWavSamples, readWavIntegerCode } from './wav.js';
import { decodeFlac } from './flac/decode.js';
import { ditherValue } from './core/quantize.js';

/** Read a produced WAV/FLAC container without consulting any report. */
export class IndependentReader {
  constructor(bytes, container = 'wav') {
    this.bytes = bytes;
    this.container = container;
    if (container === 'flac') {
      const dec = decodeFlac(bytes);
      this.kind = 'pcm';
      this.channels = dec.streamInfo.channels;
      this.sampleRate = dec.streamInfo.sampleRate;
      this.bits = dec.streamInfo.bits;
      this.frames = dec.samples;
      this._codes = dec.audio;
      this._header = null;
      this.md5Ok = dec.md5Ok;
      this.warnings = dec.warnings;
    } else {
      const header = parseWavHeader(bytes);
      this._header = header;
      this.kind = header.kind;
      this.channels = header.channels;
      this.sampleRate = header.sampleRate;
      this.bits = header.bitsPerSample;
      this.frames = header.totalFrames;
      this.declaredFrames = header.declaredFrames;
      this.truncated = !!header.truncated || this.frames < header.declaredFrames;
      this._codes = null;
    }
    this.scale = Math.pow(2, this.bits - 1);
    this.maxCode = this.scale - 1;
    this.minCode = -this.scale;
  }

  /** True integer code at (frame, channel), read straight from the bytes. */
  codeAt(frame, channel) {
    if (this.kind !== 'pcm') throw new Error('codeAt requires an integer PCM container');
    if (frame < 0 || frame >= this.frames) throw new RangeError(`frame ${frame} out of 0..${this.frames - 1}`);
    if (this.container === 'flac') return this._codes[frame * this.channels + channel];
    return readWavIntegerCode(this._header, this.bytes, frame, channel);
  }

  /** All interleaved codes, materialised lazily so short scans stay cheap. */
  codes() {
    if (this._codes) return this._codes;
    const out = new Int32Array(this.frames * this.channels);
    for (let f = 0; f < this.frames; f++) {
      for (let c = 0; c < this.channels; c++) out[f * this.channels + c] = this.codeAt(f, c);
    }
    this._codes = out;
    return out;
  }

  decodedSamples() {
    if (this.container === 'flac') {
      const out = new Float64Array(this._codes.length);
      for (let i = 0; i < out.length; i++) out[i] = this._codes[i] / this.scale;
      return out;
    }
    return decodeWavSamples(this._header, this.bytes, this.frames);
  }

  /**
   * Scan for saturation independently: a saturated sample sits on either rail
   * code. Runs are merged so the answer names channel + absolute time range,
   * not just a count. An anomaly confined to the final partial block is still
   * attributed to its exact source frames.
   */
  scanSaturation() {
    const events = [];
    for (let c = 0; c < this.channels; c++) {
      let runStart = -1;
      let runCode = 0;
      const flush = (endFrame) => {
        if (runStart < 0) return;
        events.push({
          channel: c,
          startFrame: runStart,
          endFrame: endFrame - 1,
          startTime: runStart / this.sampleRate,
          endTime: (endFrame - 1) / this.sampleRate,
          rail: runCode === this.maxCode ? 'positive' : 'negative',
          code: runCode,
          frames: endFrame - runStart,
        });
        runStart = -1;
      };
      for (let f = 0; f < this.frames; f++) {
        const code = this.codeAt(f, c);
        const onRail = code === this.maxCode || code === this.minCode;
        if (onRail && runStart < 0) {
          runStart = f;
          runCode = code;
        } else if (onRail && code === runCode) {
          continue;
        } else if (onRail) {
          flush(f);
          runStart = f;
          runCode = code;
        } else {
          flush(f);
        }
      }
      flush(this.frames);
    }
    events.sort((a, b) => a.startFrame - b.startFrame || a.channel - b.channel);
    return {
      saturated: events.length > 0,
      events,
      totalSaturatedFrames: events.reduce((n, e) => n + e.frames, 0),
      channels: this.channels,
      sampleRate: this.sampleRate,
    };
  }
}

/**
 * The standalone integer quantization formula, applied to one float sample.
 * No shared quantizer state is used: given (seed, absolute frame, channel) the
 * dither term is a pure function, so this is the independent oracle the
 * written codes are checked against.
 */
export function expectedIntegerCode(x, { bits, gain, dither, seed, frame, channel }) {
  const scale = Math.pow(2, bits - 1);
  let v = Number.isFinite(x) ? x : 0;
  v = v * gain;
  const d = dither === 'none' || !dither ? 0 : ditherValue(seed >>> 0, frame, channel, dither);
  let q = Math.floor(v * scale + d + 0.5);
  const maxCode = scale - 1;
  const minCode = -scale;
  if (q > maxCode) q = maxCode;
  else if (q < minCode) q = minCode;
  return q;
}

/**
 * Recompute every expected code sample by sample from the float source and
 * compare it to the codes the independent reader pulls back out of the
 * container. With dither off this is pure independent integer quantization;
 * with a fixed seed the dither term is located by (absolute frame, channel).
 *
 * `source.read(start, frames)` returns interleaved Float64Array frames.
 */
export function pointwiseQuantizationCheck({ reader, source, gain, bits, dither, seed, blockFrames = 4096 }) {
  const channels = reader.channels;
  const mismatches = [];
  let compared = 0;
  let maxAbsDiff = 0;
  for (let start = 0; start < reader.frames; start += blockFrames) {
    const n = Math.min(blockFrames, reader.frames - start);
    const block = source.read(start, n);
    for (let i = 0; i < n; i++) {
      const frame = start + i;
      for (let c = 0; c < channels; c++) {
        const idx = i * channels + c;
        const want = expectedIntegerCode(block[idx], { bits, gain, dither, seed, frame, channel: c });
        const got = reader.codeAt(frame, c);
        compared++;
        const diff = got - want;
        if (Math.abs(diff) > maxAbsDiff) maxAbsDiff = Math.abs(diff);
        if (diff !== 0 && mismatches.length < 32) {
          mismatches.push({ frame, channel: c, source: block[idx], expected: want, actual: got, diff });
        }
      }
    }
  }
  return {
    ok: mismatches.length === 0 && compared === reader.frames * channels,
    compared,
    mismatchCount: countAllMismatches({ reader, source, gain, bits, dither, seed, blockFrames }),
    firstMismatch: mismatches[0] || null,
    maxAbsDiff,
    mismatches,
  };
}

function countAllMismatches({ reader, source, gain, bits, dither, seed, blockFrames }) {
  const channels = reader.channels;
  let count = 0;
  for (let start = 0; start < reader.frames; start += blockFrames) {
    const n = Math.min(blockFrames, reader.frames - start);
    const block = source.read(start, n);
    for (let i = 0; i < n; i++) {
      const frame = start + i;
      for (let c = 0; c < channels; c++) {
        const idx = i * channels + c;
        const want = expectedIntegerCode(block[idx], { bits, gain, dither, seed, frame, channel: c });
        if (reader.codeAt(frame, c) !== want) count++;
      }
    }
  }
  return count;
}

/**
 * Per-channel error distribution in LSB. Bins integer errors from -range..+range
 * plus overflow counters. The returned histogram is the "error map" on which
 * fault signatures separate:
 *   - channel swap  -> errors spread across the full code range on both
 *                      channels, starting at the swap frame;
 *   - dither reset  -> errors stay inside +-1..2 LSB but appear at every frame
 *                      from the reset point instead of only where the dither
 *                      actually differs.
 */
export function errorDistribution({ reader, source, gain, dither, seed, blockFrames = 4096, binRange = 8 }) {
  const channels = reader.channels;
  const scale = reader.scale;
  const hist = Array.from({ length: channels }, () => {
    const h = new Map();
    return { map: h, beyond: 0, samples: 0, sumSq: 0, maxAbs: 0, firstErrorFrame: -1, firstErrorChannel: -1 };
  });
  for (let start = 0; start < reader.frames; start += blockFrames) {
    const n = Math.min(blockFrames, reader.frames - start);
    const block = source.read(start, n);
    for (let i = 0; i < n; i++) {
      const frame = start + i;
      for (let c = 0; c < channels; c++) {
        const idx = i * channels + c;
        const x = Number.isFinite(block[idx]) ? block[idx] : 0;
        const want = expectedIntegerCode(x, { bits: reader.bits, gain, dither, seed, frame, channel: c });
        const got = reader.codeAt(frame, c);
        const err = got - want; // integer LSB
        const h = hist[c];
        h.samples++;
        h.sumSq += err * err;
        if (Math.abs(err) > h.maxAbs) h.maxAbs = Math.abs(err);
        if (err !== 0 && h.firstErrorFrame < 0) {
          h.firstErrorFrame = frame;
          h.firstErrorChannel = c;
        }
        if (Math.abs(err) > binRange) h.beyond++;
        else h.map.set(err, (h.map.get(err) || 0) + 1);
      }
    }
  }
  return hist.map((h, c) => ({
    channel: c,
    samples: h.samples,
    rmsErrorLsb: Math.sqrt(h.sumSq / h.samples),
    maxAbsErrorLsb: h.maxAbs,
    beyondBinRange: h.beyond,
    firstErrorFrame: h.firstErrorFrame,
    histogram: [...h.map.entries()].sort((a, b) => a[0] - b[0]).map(([errorLsb, count]) => ({ errorLsb, count })),
  }));
}

/**
 * Classify a fault from its error-map signature. Returns the fault kind and the
 * frame where it begins. A clean track has no per-channel errors at all.
 */
export function classifyFault(errorMap, { swapThresholdLsb = 64 } = {}) {
  const active = errorMap.filter((e) => e.maxAbsErrorLsb > 0);
  if (active.length === 0) return { kind: 'clean', fromFrame: -1 };
  const earliest = Math.min(...active.map((e) => e.firstErrorFrame));
  const wide = active.some((e) => e.maxAbsErrorLsb >= swapThresholdLsb || e.beyondBinRange > 0);
  if (wide) {
    return {
      kind: 'channel-swap',
      fromFrame: earliest,
      detail: 'errors span many LSBs on at least one channel: sample content moved between channels',
    };
  }
  return {
    kind: 'dither-reset',
    fromFrame: earliest,
    detail: 'errors stay within the dither envelope (+-a few LSB) but begin at a block boundary',
  };
}

/**
 * Float-input round trip: float WAV in -> float WAV out and back through the
 * independent float decoder. Checks that finite values survive at the target
 * width and non-finite values were sanitized to silence.
 */
export function floatRoundTripCheck({ floatReader, source, gain, bits, blockFrames = 4096 }) {
  const width = bits === 32 ? Math.fround : (v) => v;
  const channels = floatReader.channels;
  let mismatches = 0;
  let first = null;
  let compared = 0;
  for (let start = 0; start < floatReader.frames; start += blockFrames) {
    const n = Math.min(blockFrames, floatReader.frames - start);
    const block = source.read(start, n);
    const decoded = floatReader.decodedSamples();
    for (let i = 0; i < n; i++) {
      const frame = start + i;
      for (let c = 0; c < channels; c++) {
        const idx = i * channels + c;
        const raw = block[idx];
        const want = width(Number.isFinite(raw) ? raw * gain : 0);
        const got = decoded[frame * channels + c];
        compared++;
        if (!(Object.is(want, got) || want === got)) {
          mismatches++;
          if (!first) first = { frame, channel: c, expected: want, actual: got };
        }
      }
    }
  }
  return { ok: mismatches === 0, compared, mismatches, firstMismatch: first };
}
