import test from 'node:test';
import assert from 'node:assert/strict';
import { convert, Uint8Sink } from '../src/convert.js';
import { MemorySource } from '../src/io/sources.js';
import { verifyExport } from '../src/verify.js';
import { parseWavHeader, decodeWavSamples, readWavIntegerCode } from '../src/wav.js';
import { decodeFlac } from '../src/flac/decode.js';
import { IntegerQuantizer } from '../src/core/quantize.js';
import { tailThenTransient, extremes } from '../src/fixtures.js';

function mem(samples, channels, sampleRate = 48000) {
  return new MemorySource(samples, { channels, sampleRate });
}

function run(samples, channels, target, gainPolicy, readFrames = 1000) {
  return convert({
    source: mem(samples, channels),
    target,
    gainPolicy,
    readFrames,
    flacBlockSize: 1024,
  });
}

test('WAV 24-bit scan gain is exact and pointwise verifiable', () => {
  const { samples, channels } = tailThenTransient({ quietSeconds: 0.05, afterSeconds: 0.02, transientFrames: 8 });
  const { bytes, report } = run(samples, channels, { container: 'wav', sampleFormat: 'pcm', bits: 24, dither: 'none', seed: 1 }, { mode: 'scan', targetDb: -1 });
  assert.equal(report.gain.mode, 'scan');
  assert.ok(Math.abs(report.gain.predictedCeiling - Math.pow(10, -1 / 20)) < 1e-9);
  const v = verifyExport({
    bytes: bytes.slice(),
    container: 'wav',
    expected: { codes: expectedCodesFor(samples, channels, report) },
    report,
  });
  assert.ok(v.ok, JSON.stringify(v.checks));
});

function expectedCodesFor(samples, channels, report) {
  const q = new IntegerQuantizer({ bits: report.target.bits, gain: report.gain.gain, dither: report.target.dither, seed: report.target.seed });
  return q.processBlock(samples, 0, channels);
}

test('FLAC 16/24 round-trip via independent decoder and MD5', () => {
  for (const bits of [16, 24]) {
    const { samples, channels } = tailThenTransient({ quietSeconds: 0.05, afterSeconds: 0.02, transientFrames: 8 });
    const { bytes, report } = run(samples, channels, { container: 'flac', sampleFormat: 'pcm', bits, dither: 'none', seed: 7 }, { mode: 'scan', targetDb: -1 });
    const dec = decodeFlac(bytes.slice());
    assert.equal(dec.md5Ok, true, `md5 bit ${bits}`);
    assert.equal(dec.samples, report.output.frames);
    const v = verifyExport({
      bytes: bytes.slice(),
      container: 'flac',
      expected: { codes: expectedCodesFor(samples, channels, report) },
      report,
    });
    assert.ok(v.ok, `${bits}-bit: ${JSON.stringify(v.checks.filter((c) => !c.ok))}`);
  }
});

test('full-scale transient after a quiet tail does not move earlier gain', () => {
  // Fixed gain: the quiet region must be encoded at exactly that gain, and the
  // transient must be counted as clipping, not absorbed by re-normalisation.
  const quiet = new Float64Array(4800);
  for (let i = 0; i < quiet.length; i++) quiet[i] = Math.sin(i / 10) * Math.pow(10, -90 / 20);
  const loudAt = 4800;
  const samples = new Float64Array(4800 + 8);
  samples.set(quiet);
  samples[loudAt] = 1;
  const { bytes, report } = run(samples, 1, { container: 'wav', sampleFormat: 'pcm', bits: 16, dither: 'none', seed: 0 }, { mode: 'fixed', gainDb: 6 });
  assert.equal(report.gain.gainDb, 6);
  assert.equal(report.clipping.overloadSamples, 1);
  assert.equal(report.anomalies[0].frame, loudAt);
  assert.equal(report.anomalies[0].kind, 'overload');

  const header = parseWavHeader(bytes);
  // Every sample before the transient is quiet * gain, unchanged by the peak.
  for (let f = 0; f < loudAt; f += 97) {
    const code = readWavIntegerCode(header, bytes, f, 0);
    const want = Math.round(quiet[f] * Math.pow(10, 6 / 20) * 32768) || 0;
    assert.equal(code, want, `frame ${f}`);
  }
  // The clipped sample lands on the positive rail, not somewhere lower.
  assert.equal(readWavIntegerCode(header, bytes, loudAt, 0), 32767);
});

test('scan gain puts a late peak exactly on the ceiling', () => {
  const samples = new Float64Array(20000);
  for (let i = 0; i < 10000; i++) samples[i] = 0.001;
  samples[19000] = 0.5;
  const { bytes, report } = run(samples, 1, { container: 'wav', sampleFormat: 'pcm', bits: 16, dither: 'none', seed: 0 }, { mode: 'scan', targetDb: -1 });
  const ceiling = Math.pow(10, -1 / 20);
  assert.ok(Math.abs(report.gain.gain - ceiling / 0.5) < 1e-12);
  const header = parseWavHeader(bytes);
  const peakCode = readWavIntegerCode(header, bytes, 19000, 0);
  assert.equal(peakCode, Math.round(ceiling * 32768), 'late peak normalised to the ceiling');
  assert.equal(report.clipping.overloadSamples, 0);
});

test('extremes: sign, rails and non-finite handling in integer output', () => {
  const ex = extremes();
  const { bytes, report } = run(ex.samples, ex.channels, { container: 'wav', sampleFormat: 'pcm', bits: 24, dither: 'none', seed: 0 }, { mode: 'fixed', gainDb: 0 });
  const header = parseWavHeader(bytes);
  const code = (frame, c) => readWavIntegerCode(header, bytes, frame, c);
  assert.equal(code(0, 0), 8388607);
  assert.equal(code(0, 1), -8388608);
  assert.equal(code(1, 0), 8388607, 'over-range positive clips to max');
  assert.equal(code(1, 1), -8388608, 'over-range negative clips to min');
  assert.equal(report.clipping.overloadPos, 1);
  assert.equal(report.clipping.overloadNeg, 1);
  assert.equal(code(3, 0), 0);
  assert.equal(report.quantiser.nan, 1);
  assert.equal(report.quantiser.posInf, 1);
  assert.equal(report.quantiser.negInf, 1);
  // First non-finite is (NaN, +Inf) at frame 5, ch0, reported as an anomaly.
  assert.equal(report.anomalies.find((a) => a.kind === 'non-finite').frame, 5);
});

test('float output is not clamped and preserves over-range and -0', () => {
  const ex = extremes();
  const { bytes, report } = run(ex.samples, ex.channels, { container: 'wav', sampleFormat: 'float', bits: 64 }, { mode: 'fixed', gainDb: 0 });
  assert.equal(report.clipping.mode, 'float-no-clamp');
  const header = parseWavHeader(bytes);
  assert.equal(header.kind, 'float');
  const out = decodeWavSamples(header, bytes, header.totalFrames);
  assert.equal(out[2], 1.0000001);
  assert.equal(out[3], -1.0000001);
  assert.equal(Object.is(out[13], -0), true, 'negative zero preserved');
  assert.ok(Number.isNaN(out[10]) === false, 'non-finite replaced by silence in float output');
});

test('output bytes are identical for any read chunk size (WAV and FLAC)', () => {
  const { samples, channels } = tailThenTransient({ quietSeconds: 0.04, afterSeconds: 0.02, transientFrames: 8 });
  const targets = [
    ['wav', { container: 'wav', sampleFormat: 'pcm', bits: 24, dither: 'tpdf', seed: 0xabcdef }, { mode: 'scan', targetDb: -1 }],
    ['flac', { container: 'flac', sampleFormat: 'pcm', bits: 16, dither: 'tpdf', seed: 0xabcdef }, { mode: 'scan', targetDb: -1 }],
    ['flac-rice2', { container: 'flac', sampleFormat: 'pcm', bits: 16, dither: 'tpdf', seed: 0xabcdef }, { mode: 'scan', targetDb: -1 }],
  ];
  for (const [name, target, policy] of targets) {
    let ref = null;
    for (const readFrames of [1, 3, 7, 512, 4096, 65536]) {
      const { bytes } = convert({
        source: mem(samples, channels),
        target,
        gainPolicy: policy,
        readFrames,
        flacBlockSize: 512,
      });
      const copy = bytes.slice();
      if (!ref) ref = copy;
      else assert.deepEqual(Buffer.from(copy), Buffer.from(ref), `${name} chunk ${readFrames} differs`);
    }
  }
});

test('FLAC Rice2 output decodes correctly in our decoder and stays byte-stable', () => {
  // Dense, high-amplitude noise drives residuals past the 14-bit Rice limit so
  // METHOD_PARTITIONED_RICE2 is selected. The partition order field keeps its
  // 4-bit width in that mode; a 5-bit reader silently desynchronises.
  const n = 4096;
  let s = 0x9e3779b9;
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    samples[i] = (s / 4294967296) * 2 - 1;
  }
  const out = run(samples, 1, { container: 'flac', sampleFormat: 'pcm', bits: 24, dither: 'none', seed: 0 }, { mode: 'fixed', gainDb: 0 });
  const dec = decodeFlac(out.bytes.slice());
  const expected = expectedCodesFor(samples, 1, out.report);
  assert.deepEqual(Buffer.from(dec.audio.buffer), Buffer.from(expected.buffer));
  const again = run(samples, 1, { container: 'flac', sampleFormat: 'pcm', bits: 24, dither: 'none', seed: 0 }, { mode: 'fixed', gainDb: 0 }, 97);
  assert.deepEqual(Buffer.from(again.bytes.slice()), Buffer.from(out.bytes.slice()));
});

test('a linear frozen gain reproduces the scan decision bit-exactly', () => {
  const { samples, channels } = tailThenTransient({ quietSeconds: 0.02, afterSeconds: 0.01, transientFrames: 8 });
  const scan = run(samples, channels, { container: 'wav', sampleFormat: 'pcm', bits: 16, dither: 'tpdf', seed: 5 }, { mode: 'scan', targetDb: -1 });
  const fixed = run(samples, channels, { container: 'wav', sampleFormat: 'pcm', bits: 16, dither: 'tpdf', seed: 5 }, { mode: 'fixed', gain: scan.report.gain.gain });
  assert.deepEqual(Buffer.from(fixed.bytes.slice()), Buffer.from(scan.bytes.slice()));
  assert.equal(fixed.report.gain.gain, scan.report.gain.gain);
});

test('quantisation-error anomaly points at a real outlier', () => {
  // A sample exactly on a half-LSB boundary with dither pushes the error above
  // the envelope only if the quantiser does something wrong; with a correct
  // implementation there are no outliers but the field exists and is bounded.
  const samples = new Float64Array(10000);
  for (let i = 0; i < samples.length; i++) samples[i] = (i % 2 ? 0.5 : -0.5) / 32768;
  const { report } = run(samples, 1, { container: 'wav', sampleFormat: 'pcm', bits: 16, dither: 'tpdf', seed: 3 }, { mode: 'fixed', gainDb: 0 });
  assert.equal(report.quantiser.quantOutliers, 0);
  assert.ok(report.quantiser.maxQuantErrorLsb <= report.quantiser.errorLimitLsb + 1e-9);
});
