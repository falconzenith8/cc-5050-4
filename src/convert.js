// Conversion pipeline: source -> frozen gain -> quantiser -> container.
//
// Two guarantees this module exists to provide:
//
// 1. The gain is decided once, before the first byte is written. Neither a
//    later analysis pass nor a late transient can move it; later peaks are
//    clipped and attributed instead.
// 2. Dither is indexed by absolute frame and channel, and container frames are
//    assembled on fixed boundaries, so changing the caller's read/write chunk
//    size changes neither the samples nor (for FLAC) the bytes on disk.
//
// The core is a generator that yields {start, frames} read requests and is
// driven by either a synchronous reader (memory, Node fs) or an asynchronous
// one (Browser File/Blob slices). Both drivers share all logic.

import { IntegerQuantizer } from './core/quantize.js';
import { analysePeak, decideGain, validateGainPolicy } from './gain.js';
import { buildWavHeader, patchWavSizes, encodeWavIntegers, encodeWavFloats } from './wav.js';
import { FlacEncoder } from './flac/encode.js';

export const WAV_TARGETS = new Set(['pcm8', 'pcm16', 'pcm24', 'pcm32', 'float32', 'float64']);
export const FLAC_TARGETS = new Set(['pcm8', 'pcm12', 'pcm16', 'pcm20', 'pcm24', 'pcm32']);

export function validateTarget({ container, sampleFormat, bits, channels }) {
  const key = `${sampleFormat}${bits}`;
  if (container === 'wav') {
    if (!WAV_TARGETS.has(key)) throw new Error(`WAV cannot store ${key}; supported: ${[...WAV_TARGETS].join(', ')}`);
  } else if (container === 'flac') {
    if (sampleFormat !== 'pcm') throw new Error('FLAC is lossless integer only; use a PCM target');
    if (!FLAC_TARGETS.has(key)) throw new Error(`FLAC cannot store ${key}; supported: ${[...FLAC_TARGETS].join(', ')}`);
    if (bits > 24 && channels > 2) throw new Error('FLAC: >24-bit streams are limited to 2 channels by this encoder');
  } else {
    throw new Error(`unknown container ${container}`);
  }
  return key;
}

/** Growable in-memory byte sink. `onWrite` sees every chunk. */
export class Uint8Sink {
  constructor(initial = 1 << 20) {
    this.buf = new Uint8Array(initial);
    this.length = 0;
    this.onWrite = null;
  }

  _ensure(n) {
    if (this.length + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.length + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  write(bytes) {
    this._ensure(bytes.length);
    this.buf.set(bytes, this.length);
    this.length += bytes.length;
    if (this.onWrite) this.onWrite(bytes);
  }

  patch(offset, bytes) {
    this._ensure(offset + bytes.length);
    this.buf.set(bytes, offset);
  }

  read(offset, length) {
    return this.buf.slice(offset, offset + length);
  }

  result() {
    return this.buf.subarray(0, this.length);
  }
}

/**
 * Collects quantised frames and emits them at fixed frame boundaries so the
 * container layout never depends on source read sizes.
 */
class FrameAssembler {
  constructor(channels, framesPerChunk, emit, TypedArray = Int32Array) {
    this.channels = channels;
    this.framesPerChunk = framesPerChunk;
    this.emit = emit;
    this.buf = new TypedArray(framesPerChunk * channels);
    this.frames = 0;
    this.startFrame = 0;
  }

  push(codes) {
    const channels = this.channels;
    let src = 0;
    let remaining = codes.length / channels;
    while (remaining > 0) {
      const space = this.framesPerChunk - this.frames;
      const take = Math.min(space, remaining);
      this.buf.set(codes.subarray(src * channels, (src + take) * channels), this.frames * channels);
      this.frames += take;
      src += take;
      remaining -= take;
      if (this.frames === this.framesPerChunk) this.flush();
    }
  }

  flush() {
    if (this.frames === 0) return;
    this.emit(this.buf.subarray(0, this.frames * this.channels), this.startFrame, this.frames);
    this.startFrame += this.frames;
    this.frames = 0;
  }
}

/**
 * The shared core. Yields `{start, frames}` for the driver to fetch from the
 * source; the driver sends the Float64Array back with `gen.next(block)`.
 * The generator returns { bytes, report, quantizer, decision, analysis }.
 */
function* conversionCore(opts) {
  const {
    source,
    target,
    gainPolicy,
    readFrames = 65536,
    flacBlockSize = 4096,
    analysisBlockFrames = 262144,
    onProgress = null,
    pauseAt = null,
    onPause = null,
  } = opts;

  const channels = source.channels;
  const sampleRate = source.sampleRate;
  const totalFrames = source.frames;
  if (!(totalFrames > 0)) throw new Error('source has no frames');
  if (!(channels >= 1 && channels <= 8)) throw new Error('source has unsupported channel count');

  const sampleFormat = target.sampleFormat;
  const bits = target.bits;
  validateTarget({ container: target.container, sampleFormat, bits, channels });
  validateGainPolicy(gainPolicy);

  const isFloatOut = sampleFormat === 'float';
  const dither = isFloatOut ? 'none' : target.dither || 'tpdf';
  const seed = target.seed >>> 0;
  const startedAt = Date.now();

  // ---- pass 1: measure the whole source -----------------------------------
  let peak = 0;
  let peakFrame = -1;
  let peakChannel = -1;
  let nonFinite = 0;
  let firstNonFinite = -1;
  let firstNonFiniteKind = null;
  let sumSq = 0;
  let count = 0;
  for (let start = 0; start < totalFrames; start += analysisBlockFrames) {
    const frames = Math.min(analysisBlockFrames, totalFrames - start);
    const block = yield { start, frames };
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
        }
        sumSq += v * v;
        count++;
      }
    }
    if (onProgress) onProgress((0.35 * (start + frames)) / totalFrames);
  }
  const analysis = {
    peak,
    peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
    peakFrame,
    peakChannel,
    rms: count > 0 ? Math.sqrt(sumSq / count) : 0,
    rmsDb: count > 0 && sumSq > 0 ? 10 * Math.log10(sumSq / count) : -Infinity,
    nonFinite,
    firstNonFinite,
    firstNonFiniteKind,
  };

  // ---- freeze the gain ----------------------------------------------------
  const decision = decideGain({
    analysis,
    policy: gainPolicy,
    targetCeiling: gainPolicy.targetCeiling ?? 1,
    targetDb: gainPolicy.targetDb ?? null,
  });
  const gain = decision.gain;

  // ---- set up the sink and container -------------------------------------
  const sink = opts.sink || new Uint8Sink(Math.max(1 << 20, Math.min(totalFrames * channels * Math.ceil(bits / 8) + 4096, 1 << 30)));
  const streaming = !!opts.sink;
  const quantizer = isFloatOut
    ? null
    : new IntegerQuantizer({
        bits,
        gain,
        dither,
        seed,
        overflow: target.overflow || 'saturate',
        nonFinite: opts.sanitizeNonFinite === false ? 'fail' : 'sanitize',
      });

  let wavPatches = null;
  let flacEncoder = null;
  let flacLayout = null;
  const blockReports = [];
  let outputFrames = 0;

  if (target.container === 'wav') {
    const header = buildWavHeader({
      sampleRate,
      channels,
      bits,
      kind: isFloatOut ? 'float' : 'pcm',
      frames: totalFrames,
      forceRF64: !!target.forceRF64,
    });
    wavPatches = header.patches;
    sink.write(header.bytes);
  } else {
    flacEncoder = new FlacEncoder({ sampleRate, channels, bits, blockSize: flacBlockSize });
    const comments = [
      'ENCODER=master-format-lab',
      `GAIN_DB=${decision.gainDb.toFixed(9)}`,
      `GAIN_MODE=${decision.mode}`,
      `SOURCE_PEAK_DBFS=${analysis.peakDb.toFixed(9)}`,
      `TARGET_CEILING_DBFS=${(20 * Math.log10(decision.targetCeiling)).toFixed(9)}`,
      `DITHER=${dither.toUpperCase()}`,
      `SEED=${seed}`,
    ];
    flacLayout = flacEncoder.metadataLayout({ comments, totalSamples: totalFrames });
    sink.write(flacLayout.bytes);
  }

  const writeChunk = (codes, startFrame, frames) => {
    // Expose the assembler's absolute frame range to a segmented sink before
    // the bytes move; a failed write therefore cannot be committed to its
    // index. Plain sinks ignore the extra property.
    if (sink.pendingRange !== undefined) sink.pendingRange = { startFrame, frames };
    if (isFloatOut) {
      const out = new Float64Array(codes.length);
      for (let i = 0; i < out.length; i++) out[i] = codes[i] * gain;
      sink.write(encodeWavFloats(out, bits).bytes);
    } else if (target.container === 'wav') {
      sink.write(encodeWavIntegers(codes, bits).bytes);
    } else {
      sink.write(flacEncoder.encodeFrame(codes, 0, frames));
    }
    outputFrames += frames;
  };

  const assembler = target.container === 'wav'
    ? new FrameAssembler(channels, Math.max(1, readFrames), writeChunk, isFloatOut ? Float64Array : Int32Array)
    : new FrameAssembler(channels, flacBlockSize, writeChunk);

  // ---- pass 2: quantise and write -----------------------------------------
  let processed = 0;
  let carry = null; // no carry needed; reads align on frame boundaries
  while (processed < totalFrames) {
    const frames = Math.min(readFrames, totalFrames - processed);
    if (pauseAt && pauseAt(processed, frames)) {
      // Explicit pause between write segments. The generator retains all
      // state; resuming simply continues the same loop with no re-read.
      if (onPause) onPause({ start: processed, frames, outputFrames });
    }
    const block = yield { start: processed, frames };
    if (isFloatOut) {
      const codes = new Float64Array(block.length);
      let bpeak = 0;
      let bnonFinite = 0;
      let over = 0;
      for (let i = 0; i < block.length; i++) {
        const v = block[i];
        if (!Number.isFinite(v)) {
          bnonFinite++;
          codes[i] = 0;
        } else {
          const a = Math.abs(v);
          if (a > bpeak) bpeak = a;
          if (a * gain > 1) over++;
          codes[i] = v;
        }
      }
      blockReports.push({ startFrame: processed, frames, peak: bpeak, amplifiedPeak: bpeak * gain, overFullScaleSamples: over, nonFinite: bnonFinite });
      assembler.push(codes);
    } else {
      const codes = quantizer.processBlock(block, processed, channels);
      let bpeak = 0;
      for (let i = 0; i < block.length; i++) {
        const a = Math.abs(block[i]);
        if (Number.isFinite(a) && a > bpeak) bpeak = a;
      }
      blockReports.push({ startFrame: processed, frames, peak: bpeak });
      assembler.push(codes);
    }
    processed += frames;
    if (onProgress) onProgress(0.35 + (0.65 * processed) / totalFrames);
  }
  assembler.flush();

  // ---- finalise -----------------------------------------------------------
  if (target.container === 'wav') {
    const dataSize = sink.length - (wavPatches.dataSize + 4);
    const headerCopy = sink.read(0, wavPatches.dataSize + 4);
    patchWavSizes(headerCopy, wavPatches, { dataSize, frames: outputFrames });
    sink.patch(0, headerCopy);
  } else {
    sink.patch(flacLayout.streamInfoOffset, flacEncoder.finalStreamInfo());
  }

  // ---- anomaly pointers ---------------------------------------------------
  const anomalies = [];
  if (!isFloatOut) {
    const qs = quantizer.stats;
    const consider = (frame, kind, channel, detail) => {
      if (frame < 0) return;
      anomalies.push({ frame, time: frame / sampleRate, kind, channel, detail });
    };
    consider(qs.firstOverload, 'overload', qs.firstOverloadChannel, 'sample exceeded full scale after the frozen gain (clipped)');
    consider(qs.firstClamp, 'full-scale-clamp', -1, 'quantiser rounded onto a full-scale code');
    consider(qs.firstQuantOutlier, 'quant-error', qs.firstQuantOutlierChannel, 'quantisation error outside the dither envelope');
    consider(qs.firstNonFinite, 'non-finite', qs.firstNonFiniteChannel, `non-finite input (${qs.firstNonFiniteKind}) replaced with silence`);
  } else if (firstNonFinite >= 0) {
    anomalies.push({ frame: firstNonFinite, time: firstNonFinite / sampleRate, kind: 'non-finite', channel: -1, detail: `non-finite input (${firstNonFiniteKind}) replaced with silence` });
  }
  anomalies.sort((a, b) => a.frame - b.frame);

  const output = sink.result();
  const outputBytes = output ? output.length : sink.length;
  const report = {
    createdAt: new Date(startedAt).toISOString(),
    elapsedMs: Date.now() - startedAt,
    source: source.describe ? source.describe() : { channels, sampleRate, frames: totalFrames },
    target: {
      container: target.container,
      sampleFormat,
      bits,
      dither,
      seed,
      flacBlockSize: target.container === 'flac' ? flacBlockSize : null,
      readFrames,
    },
    gain: {
      ...decision,
      frozenBeforeFirstWrite: true,
      lateChangePolicy: 'gain is fixed; later peaks are clipped and reported, never re-normalised',
      analysis,
    },
    output: {
      frames: outputFrames,
      channels,
      sampleRate,
      durationSeconds: outputFrames / sampleRate,
      bytes: outputBytes,
      container: target.container,
      rf64: target.container === 'wav' ? !!(wavPatches && wavPatches.ds64Data >= 0) : false,
      flacMD5: target.container === 'flac' ? flacEncoder.md5.hex() : null,
    },
    quantiser: isFloatOut ? null : quantizer.summary(),
    clipping: isFloatOut
      ? { mode: 'float-no-clamp', overFullScaleSamples: analysis.peak * gain > 1 }
      : {
          mode: target.overflow || 'saturate',
          overloadSamples: quantizer.stats.overloadPos + quantizer.stats.overloadNeg,
          overloadPos: quantizer.stats.overloadPos,
          overloadNeg: quantizer.stats.overloadNeg,
          fullScaleClamped: quantizer.stats.fullScaleClampPos + quantizer.stats.fullScaleClampNeg,
        },
    anomalies,
    blocks: blockReports.length,
  };
  if (target.container === 'flac') {
    report.flac = {
      blockSize: flacBlockSize,
      frames: flacEncoder.frameNumber,
      minFrameSize: flacEncoder.minFrameSize,
      maxFrameSize: flacEncoder.maxFrameSize,
    };
  }
  if (opts.includeBlockDetail) report.blockDetail = blockReports;

  return { bytes: output, byteLength: outputBytes, report, quantizer, decision, analysis, sink };
}

/** Drive the core with a synchronous `source.read(start, frames)`. */
export function convert(opts) {
  const gen = conversionCore(opts);
  let step = gen.next();
  while (!step.done) {
    const { start, frames } = step.value;
    step = gen.next(opts.source.read(start, frames));
  }
  return step.value;
}

/** Drive the core with an async `source.read` returning a Promise. */
export async function convertAsync(opts) {
  const gen = conversionCore(opts);
  let step = gen.next();
  while (!step.done) {
    const { start, frames } = step.value;
    step = gen.next(await opts.source.read(start, frames));
  }
  return step.value;
}

/**
 * Regenerate the exact integer codes the converter should have written,
 * without touching the container. Async-aware for Blob sources.
 */
export function expectedCodes({ source, gain, bits, dither, seed, readFrames = 65536 }) {
  const out = new Int32Array(source.frames * source.channels);
  const q = new IntegerQuantizer({ bits, gain, dither, seed });
  for (let start = 0; start < source.frames; start += readFrames) {
    const take = Math.min(readFrames, source.frames - start);
    const block = source.read(start, take);
    out.set(q.processBlock(block, start, source.channels), start * source.channels);
  }
  return { codes: out, stats: q.summary() };
}

export async function expectedCodesAsync({ source, gain, bits, dither, seed, readFrames = 65536 }) {
  const out = new Int32Array(source.frames * source.channels);
  const q = new IntegerQuantizer({ bits, gain, dither, seed });
  for (let start = 0; start < source.frames; start += readFrames) {
    const take = Math.min(readFrames, source.frames - start);
    const block = await source.read(start, take);
    out.set(q.processBlock(block, start, source.channels), start * source.channels);
  }
  return { codes: out, stats: q.summary() };
}
