// Rerunnable fidelity tests for the sampling/conversion window.
//
// Every test rebuilds its signals from the deterministic fixtures and drives
// the real converter, then re-parses the produced container with the
// IndependentReader (no report is trusted). The same suite covers:
//
//   * float read-in -> integer write-out -> independent re-decode;
//   * sample-by-sample independent integer quantization, with and without
//     fixed-seed dither, and the dither's absolute (frame, channel) keying;
//   * saturation attributed to channel + absolute time, including an anomaly
//     confined to the final partial block;
//   * channel-swap vs dither-reset faults showing separable error maps.

import test from 'node:test';
import assert from 'node:assert/strict';
import { convert } from '../src/convert.js';
import { MemorySource } from '../src/io/sources.js';
import { parseWavHeader } from '../src/wav.js';
import {
  IndependentReader,
  expectedIntegerCode,
  pointwiseQuantizationCheck,
  errorDistribution,
  classifyFault,
  floatRoundTripCheck,
} from '../src/fidelity.js';
import { fidelitySignal, lowTriangle, overFullScaleNegative, mulberry32 } from '../src/fixtures.js';
import { ditherValue } from '../src/core/quantize.js';

const SR = 48000;
const CH = 2;

function mem(samples, channels = CH, sampleRate = SR) {
  return new MemorySource(samples, { channels, sampleRate });
}

function run(samples, target, { readFrames = 128, gainDb = 0, flacBlockSize = 256 } = {}) {
  return convert({
    source: mem(samples, target.__channels || CH),
    target,
    gainPolicy: { mode: 'fixed', gainDb },
    readFrames,
    flacBlockSize,
  });
}

test('float read-in, integer write-out and re-decode match the standalone formula (no dither)', () => {
  const fx = fidelitySignal({ blockFrames: 256, lowLevelFrames: 600 });
  for (const bits of [16, 24]) {
    const { bytes, report } = run(fx.samples, { container: 'wav', sampleFormat: 'pcm', bits, dither: 'none', seed: 1 });
    const reader = new IndependentReader(bytes, 'wav');
    assert.equal(reader.frames, fx.totalFrames);
    const pw = pointwiseQuantizationCheck({
      reader,
      source: mem(fx.samples),
      gain: report.gain.gain,
      bits,
      dither: 'none',
      seed: 1,
    });
    assert.ok(pw.ok, `${bits}-bit pointwise: ${pw.mismatchCount} mismatches, first ${JSON.stringify(pw.firstMismatch)}`);
    assert.equal(pw.compared, fx.totalFrames * CH);

    // Hand-check the ramp extrema against the documented integer formula.
    const scale = Math.pow(2, bits - 1);
    assert.equal(reader.codeAt(0, 0), expectedIntegerCode(fx.samples[0], { bits, gain: 1, dither: 'none', seed: 1, frame: 0, channel: 0 }));
    assert.equal(reader.codeAt(0, 0), -scale, 'ramp starts on the negative rail');
  }
});

test('float WAV input round-trips through float32/64 output and re-decode', () => {
  const fx = fidelitySignal({ blockFrames: 256, lowLevelFrames: 600 });
  for (const bits of [32, 64]) {
    const { bytes } = run(fx.samples, { container: 'wav', sampleFormat: 'float', bits, __channels: CH });
    const header = parseWavHeader(bytes);
    assert.equal(header.kind, 'float');
    const reader = new IndependentReader(bytes, 'wav');
    assert.equal(reader.kind, 'float');
    const rt = floatRoundTripCheck({
      floatReader: reader,
      source: mem(fx.samples),
      gain: 1,
      bits,
    });
    assert.ok(rt.ok, `float${bits} round-trip: ${rt.mismatches} mismatches, first ${JSON.stringify(rt.firstMismatch)}`);
    assert.equal(rt.compared, fx.samples.length);
  }
});

test('no-dither output obeys the independent integer formula sample by sample', () => {
  const rnd = mulberry32(2026);
  const frames = 2000;
  const samples = new Float64Array(frames * CH);
  for (let i = 0; i < frames; i++) {
    samples[i * CH] = (rnd() * 2 - 1) * 0.9;
    samples[i * CH + 1] = (rnd() * 2 - 1) * 0.4;
  }
  const bits = 16;
  const gain = 0.75;
  const { bytes } = run(samples, { container: 'wav', sampleFormat: 'pcm', bits, dither: 'none', seed: 0 }, { gainDb: 20 * Math.log10(gain) });
  const reader = new IndependentReader(bytes, 'wav');
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < CH; c++) {
      const want = expectedIntegerCode(samples[f * CH + c], { bits, gain, dither: 'none', seed: 0, frame: f, channel: c });
      assert.equal(reader.codeAt(f, c), want, `frame ${f} ch ${c}`);
    }
  }
});

test('fixed-seed dither is keyed by absolute frame and channel, not write block', () => {
  const fx = fidelitySignal({ blockFrames: 128, lowLevelFrames: 400 });
  const target = { container: 'wav', sampleFormat: 'pcm', bits: 16, dither: 'tpdf', seed: 0x9e3779b9 };
  const chunkA = run(fx.samples, target, { readFrames: 17 }).bytes;
  const chunkB = run(fx.samples, target, { readFrames: 503 }).bytes;
  assert.deepEqual(Buffer.from(chunkA), Buffer.from(chunkB), 'blocking must not move dither');

  // Explicitly: the dither term at (frame, channel) is a pure hash, identical
  // regardless of how many blocks were processed before it.
  const d1 = ditherValue(0x9e3779b9, 1234, 0, 'tpdf');
  const d2 = ditherValue(0x9e3779b9, 1234, 0, 'tpdf');
  assert.equal(d1, d2);
  assert.notEqual(ditherValue(0x9e3779b9, 1234, 0, 'tpdf'), ditherValue(0x9e3779b9, 1234, 1, 'tpdf'));
  assert.notEqual(ditherValue(0x9e3779b9, 1234, 0, 'tpdf'), ditherValue(0x9e3779b9, 1235, 0, 'tpdf'));

  // Pointwise check using absolute frame indexing still passes for every block.
  const pointwiseBytes = run(fx.samples, target, { readFrames: 33 }).bytes;
  const reader = new IndependentReader(pointwiseBytes, 'wav');
  const pw = pointwiseQuantizationCheck({ reader, source: mem(fx.samples), gain: 1, bits: 16, dither: 'tpdf', seed: 0x9e3779b9 });
  assert.ok(pw.ok, `absolute-keyed dither pointwise: ${JSON.stringify(pw.firstMismatch)}`);
});

test('independent saturation scan names channel, rail and absolute time range', () => {
  const fx = fidelitySignal({ blockFrames: 256, lowLevelFrames: 600 });
  const { bytes } = run(fx.samples, { container: 'wav', sampleFormat: 'pcm', bits: 16, dither: 'none', seed: 1 });
  const reader = new IndependentReader(bytes, 'wav');
  const sat = reader.scanSaturation();
  assert.ok(sat.saturated);

  // The fixture's known clip region must be covered by a reported event on
  // each channel, with the exact frames and times.
  const clipStart = fx.marks.clipFrames[0];
  const clipEnd = fx.marks.clipFrames.at(-1);
  for (const c of [0, 1]) {
    const ev = sat.events.find((e) => e.channel === c && e.startFrame <= clipStart && e.endFrame >= clipEnd);
    assert.ok(ev, `channel ${c} has a saturation event spanning the known clip`);
    assert.equal(ev.startTime, ev.startFrame / SR);
    assert.equal(ev.rail, c === 0 ? 'positive' : 'negative');
    // Every saturated frame traces back to a genuinely over-full-scale source.
    for (let f = ev.startFrame; f <= ev.endFrame; f++) {
      assert.ok(Math.abs(fx.samples[f * CH + c]) >= 1, `frame ${f} ch ${c} was not over range`);
    }
  }
});

test('a clip confined to the final partial block still points at the source samples', () => {
  const frames = 300;
  const tailStart = 291; // last 9 frames; readFrames 64 makes this a partial tail
  const samples = new Float64Array(frames * CH);
  for (let i = 0; i < frames; i++) {
    if (i >= tailStart) {
      samples[i * CH] = -1.25;
      samples[i * CH + 1] = 1.25;
    } else {
      samples[i * CH] = Math.sin(i / 7) * 0.2;
      samples[i * CH + 1] = Math.cos(i / 7) * 0.2;
    }
  }
  const { bytes } = run(samples, { container: 'wav', sampleFormat: 'pcm', bits: 16, dither: 'none', seed: 1 }, { readFrames: 64 });
  const reader = new IndependentReader(bytes, 'wav');
  const sat = reader.scanSaturation();
  assert.equal(sat.events.length, 2);
  for (const ev of sat.events) {
    assert.equal(ev.startFrame, tailStart);
    assert.equal(ev.endFrame, frames - 1);
    assert.equal(ev.frames, frames - tailStart);
    // Reproduce the exact offending source sample.
    const sourceValue = samples[ev.startFrame * CH + ev.channel];
    assert.ok(Math.abs(sourceValue) > 1);
    assert.equal(ev.code, ev.rail === 'positive' ? reader.maxCode : reader.minCode);
  }
});

test('clip-free low-amplitude triangle reports no saturation', () => {
  const tri = lowTriangle({ frames: 400, amplitude: 0.1 });
  const { bytes } = run(tri.samples, { container: 'wav', sampleFormat: 'pcm', bits: 16, dither: 'none', seed: 1 });
  const sat = new IndependentReader(bytes, 'wav').scanSaturation();
  assert.equal(sat.saturated, false);
  assert.equal(sat.events.length, 0);
});

test('over-full-scale negative half wave saturates the negative rail only', () => {
  const fx = overFullScaleNegative({ frames: 600, overshoot: 1.5 });
  const { bytes } = run(fx.samples, { container: 'wav', sampleFormat: 'pcm', bits: 16, dither: 'none', seed: 1 });
  const reader = new IndependentReader(bytes, 'wav');
  const sat = reader.scanSaturation();
  // Channel 0 carries the full-overshoot negative lobes; only that rail fires.
  const neg = sat.events.filter((e) => e.rail === 'negative' && e.channel === 0);
  assert.ok(neg.length > 0);
  assert.ok(sat.events.every((e) => e.rail === 'negative'), 'no positive-rail saturation');
  // Union of reported negative ranges equals the fixture's over-frame set.
  const reported = new Set();
  for (const e of neg) for (let f = e.startFrame; f <= e.endFrame; f++) reported.add(f);
  for (const f of fx.overFrames) assert.ok(reported.has(f), `over frame ${f} reported`);
  assert.ok(fx.overFrames.every((f) => f < reader.frames));
});

function readerWithCodes(template, codes) {
  return {
    channels: template.channels,
    sampleRate: template.sampleRate,
    bits: template.bits,
    frames: template.frames,
    scale: template.scale,
    maxCode: template.maxCode,
    minCode: template.minCode,
    codeAt(f, c) { return codes[f * template.channels + c]; },
  };
}

test('channel swap and dither reset produce distinguishable error-map signatures', () => {
  const fx = fidelitySignal({ blockFrames: 256, lowLevelFrames: 600 });
  const bits = 16;
  const seed = 7;
  const target = { container: 'wav', sampleFormat: 'pcm', bits, dither: 'tpdf', seed };
  const { bytes } = run(fx.samples, target, { readFrames: 128 });
  const good = new IndependentReader(bytes, 'wav');
  const faultAt = 300;

  // Fault A: swap channels from faultAt onward -> large, content-scale errors.
  const swapped = new Int32Array(good.codes());
  for (let f = faultAt; f < good.frames; f++) {
    const x = swapped[f * CH];
    swapped[f * CH] = swapped[f * CH + 1];
    swapped[f * CH + 1] = x;
  }
  const swapMap = errorDistribution({
    reader: readerWithCodes(good, swapped),
    source: mem(fx.samples),
    gain: 1,
    dither: 'tpdf',
    seed,
  });
  const swapFault = classifyFault(swapMap);
  assert.equal(swapFault.kind, 'channel-swap');
  assert.equal(swapFault.fromFrame, faultAt);
  assert.ok(swapMap.some((e) => e.maxAbsErrorLsb >= 64));

  // Fault B: reset the dither at faultAt by indexing it from a local frame.
  const reset = new Int32Array(good.codes());
  for (let f = faultAt; f < good.frames; f++) {
    for (let c = 0; c < CH; c++) {
      reset[f * CH + c] = expectedIntegerCode(fx.samples[f * CH + c], {
        bits,
        gain: 1,
        dither: 'tpdf',
        seed,
        frame: f - faultAt, // bug: block-local instead of absolute
        channel: c,
      });
    }
  }
  const resetMap = errorDistribution({
    reader: readerWithCodes(good, reset),
    source: mem(fx.samples),
    gain: 1,
    dither: 'tpdf',
    seed,
  });
  const resetFault = classifyFault(resetMap);
  assert.equal(resetFault.kind, 'dither-reset');
  assert.equal(resetFault.fromFrame, faultAt);
  assert.ok(resetMap.every((e) => e.maxAbsErrorLsb <= 2), 'dither reset stays inside the dither envelope');

  assert.notEqual(swapFault.kind, resetFault.kind);
});

test('FLAC output survives the independent reader and pointwise check', () => {
  const fx = fidelitySignal({ blockFrames: 256, lowLevelFrames: 600 });
  const { bytes } = run(
    fx.samples,
    { container: 'flac', sampleFormat: 'pcm', bits: 24, dither: 'tpdf', seed: 55 },
    { flacBlockSize: 256 },
  );
  const reader = new IndependentReader(bytes, 'flac');
  assert.equal(reader.frames, fx.totalFrames);
  assert.equal(reader.md5Ok, true);
  assert.deepEqual(reader.warnings, []);
  const pw = pointwiseQuantizationCheck({ reader, source: mem(fx.samples), gain: 1, bits: 24, dither: 'tpdf', seed: 55 });
  assert.ok(pw.ok, `FLAC pointwise: ${JSON.stringify(pw.firstMismatch)}`);
  assert.ok(reader.scanSaturation().saturated, 'FLAC rail codes are detected independently');
});
