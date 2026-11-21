// End-to-end segmented conversion tests.
//
// A track is converted in blocks of deliberately uneven lengths with explicit
// pauses between them, then compared against a single uninterrupted conversion
// (the oracle). The failure case arms a one-shot sink error on the final
// partial block: the index must stop short, and the resumed run's bytes, spliced
// at the real seam, must align sample-for-sample with the oracle.

import test from 'node:test';
import assert from 'node:assert/strict';
import { convert } from '../src/convert.js';
import { MemorySource } from '../src/io/sources.js';
import { TrackingSink, FailOnceSink, unevenSegments } from '../src/segment-convert.js';
import { SegmentConcatenator, firstDivergence, locateSeamDefect } from '../src/io/segment-stream.js';
import { IndependentReader, errorDistribution, classifyFault } from '../src/fidelity.js';
import { fidelitySignal } from '../src/fixtures.js';

const SR = 48000;
const CH = 2;
const BITS = 16;
const SEED = 0x5151abcd;

function makeContext() {
  const fx = fidelitySignal({ blockFrames: 256, lowLevelFrames: 600 });
  const source = () => new MemorySource(fx.samples, { channels: CH, sampleRate: SR });
  const target = { container: 'wav', sampleFormat: 'pcm', bits: BITS, dither: 'tpdf', seed: SEED };
  const policy = { mode: 'fixed', gainDb: 0 };
  return { fx, source, target, policy };
}

function oracleBytes(ctx) {
  const sink = new TrackingSink({ channels: CH, sampleRate: SR, container: 'wav' });
  const { report } = convert({ source: ctx.source(), target: ctx.target, gainPolicy: ctx.policy, readFrames: 65536, sink });
  return { bytes: sink.result(), sink, frames: report.output.frames };
}

test('uneven blocks with pauses reproduce the uninterrupted track exactly', () => {
  const ctx = makeContext();
  const oracle = oracleBytes(ctx);

  for (const lengths of [[16, 48, 96, 32], [1, 7, 31], [16, 16, 17], [48]]) {
    const bounds = unevenSegments(ctx.fx.totalFrames, lengths);
    const pauseSet = new Set(bounds.slice(1, -1));
    const sink = new TrackingSink({ channels: CH, sampleRate: SR, container: 'wav' });
    let pausedAt = [];
    const result = convert({
      source: ctx.source(),
      target: ctx.target,
      gainPolicy: ctx.policy,
      readFrames: 16,
      sink,
      pauseAt: (start) => pauseSet.has(start),
      onPause: ({ start }) => pausedAt.push(start),
    });

    // Frame accounting: the index covers every frame exactly once. Pause
    // boundaries that do not coincide with a read-block start simply merge
    // into the next read, so assert on the pauses that actually fired.
    assert.equal(result.report.output.frames, ctx.fx.totalFrames);
    const avail = sink.index.availability(ctx.fx.totalFrames);
    assert.deepEqual(avail, { complete: true, committedFrames: ctx.fx.totalFrames, expectedFrames: ctx.fx.totalFrames, missingFrom: -1, missingFrames: 0, gaps: [] });
    assert.ok(pausedAt.length > 0, `lengths ${lengths}: at least one pause fired`);
    assert.ok(pausedAt.every((p) => pauseSet.has(p)), `lengths ${lengths}: every pause is on a segment boundary`);

    // Byte identity with the oracle and a clean seam at every pause boundary.
    assert.deepEqual(Buffer.from(sink.result()), Buffer.from(oracle.bytes), `lengths ${lengths} differ from oracle`);
    const reader = new IndependentReader(sink.result(), 'wav');
    const oracleReader = new IndependentReader(oracle.bytes, 'wav');
    for (const seam of pausedAt) {
      const defect = locateSeamDefect(oracleReader.codes(), reader.codes(), { seamFrame: seam, channels: CH, searchRadius: 16 });
      assert.equal(defect.kind, 'clean', `seam ${seam} for lengths ${lengths}`);
    }
    const dist = errorDistribution({ reader, source: ctx.source(), gain: 1, dither: 'tpdf', seed: SEED });
    assert.equal(classifyFault(dist).kind, 'clean');
    assert.ok(dist.every((e) => e.firstErrorFrame < 0), 'no per-channel errors against the absolute-keyed oracle');
  }
});

test('per-side error distribution is zero for a faithful segmented run', () => {
  const ctx = makeContext();
  const sink = new TrackingSink({ channels: CH, sampleRate: SR, container: 'wav' });
  const bounds = unevenSegments(ctx.fx.totalFrames, [53, 211, 77]);
  const pauseSet = new Set(bounds.slice(1, -1));
  convert({
    source: ctx.source(),
    target: ctx.target,
    gainPolicy: ctx.policy,
    readFrames: 48,
    sink,
    pauseAt: (start) => pauseSet.has(start),
  });
  const reader = new IndependentReader(sink.result(), 'wav');
  const dist = errorDistribution({ reader, source: ctx.source(), gain: 1, dither: 'tpdf', seed: SEED });
  assert.equal(dist.length, CH);
  for (const per of dist) {
    assert.equal(per.samples, ctx.fx.totalFrames);
    assert.equal(per.maxAbsErrorLsb, 0);
    assert.equal(per.rmsErrorLsb, 0);
    assert.equal(per.firstErrorFrame, -1);
  }
});

test('failed final partial block: index stops short, then resume aligns with the oracle', () => {
  const ctx = makeContext();
  const failAt = ctx.fx.totalFrames - 5; // inside the last <readFrames block

  // Attempt 1: sink fails once inside the tail block.
  const failSink = new FailOnceSink();
  const sink1 = new TrackingSink({ channels: CH, sampleRate: SR, container: 'wav', inner: failSink });
  failSink.arm(failAt);
  let thrown = null;
  try {
    convert({ source: ctx.source(), target: ctx.target, gainPolicy: ctx.policy, readFrames: 64, sink: sink1 });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'the tail write failure must propagate');
  assert.match(thrown.message, /injected sink failure/);
  const seam = sink1.index.contiguousEnd;
  assert.ok(seam < ctx.fx.totalFrames);
  const avail = sink1.index.availability(ctx.fx.totalFrames);
  assert.equal(avail.complete, false);
  assert.equal(avail.missingFrom, seam);
  assert.ok(avail.missingFrames > 0);
  assert.equal(sink1.index.failedWrites.length, 1);
  assert.equal(sink1.index.failedWrites[0].start, seam);

  // Attempt 2: clean rerun over the same absolute frames (fresh sink).
  const sink2 = new TrackingSink({ channels: CH, sampleRate: SR, container: 'wav' });
  convert({ source: ctx.source(), target: ctx.target, gainPolicy: ctx.policy, readFrames: 64, sink: sink2 });
  const oracleReader = new IndependentReader(sink2.result(), 'wav');

  // Physically splice: committed prefix bytes from attempt 1, tail from the
  // rerun. The concatenator then pulls across this real seam from the parts.
  const blockAlign = (BITS / 8) * CH;
  const dataOffset = 44;
  const full = sink2.result();
  const resumed = new Uint8Array(full.length);
  const prefixBytes = seam * blockAlign;
  resumed.set(sink1.read(dataOffset, prefixBytes), dataOffset);
  resumed.set(sink2.read(dataOffset + prefixBytes, full.length - (dataOffset + prefixBytes)), dataOffset + prefixBytes);
  resumed.set(sink2.read(0, dataOffset), 0);

  const reader = new IndependentReader(resumed, 'wav');
  assert.equal(reader.frames, ctx.fx.totalFrames);
  assert.equal(firstDivergence(oracleReader.codes(), reader.codes(), { channels: CH }), null);

  const decodePart = (bytes) => {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Int32Array(bytes.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, true);
    return out;
  };
  const cat = new SegmentConcatenator(sink2.index, sink2, decodePart);
  const across = cat.pullAcrossSeam(seam, 8, 8);
  assert.equal(across.seamFrame, seam);
  assert.ok(across.right.length > 0);
  const defect = locateSeamDefect(oracleReader.codes(), reader.codes(), { seamFrame: seam, channels: CH, searchRadius: 24 });
  assert.equal(defect.kind, 'clean');

  // Index of the resumed run itself is complete and gap free.
  const finalAvail = sink2.index.availability(ctx.fx.totalFrames);
  assert.equal(finalAvail.complete, true);
  assert.deepEqual(finalAvail.gaps, []);
});

test('a duplicated sample at a resume seam is located even when frame counts match', () => {
  const ctx = makeContext();
  const oracle = oracleBytes(ctx);
  const oracleCodes = new IndependentReader(oracle.bytes, 'wav').codes();

  // Simulate a resume that repeats one source frame at the seam but keeps the
  // total frame count by truncating the tail: same length, shifted content.
  const seam = 640;
  const dup = new Int32Array(oracleCodes.length);
  dup.set(oracleCodes.subarray(0, seam * CH));
  dup.set(oracleCodes.subarray((seam - 1) * CH, (oracleCodes.length / CH - 1) * CH), seam * CH);
  dup.set(oracleCodes.subarray((oracleCodes.length / CH - 1) * CH), (oracleCodes.length / CH - 1) * CH);

  const defect = locateSeamDefect(oracleCodes, dup, { seamFrame: seam, channels: CH, searchRadius: 32 });
  assert.equal(defect.kind, 'duplicated-sample');
  assert.equal(defect.lag, 1);
  assert.equal(defect.firstDivergence.frame, seam);
});

test('write log records only successful chunks and keeps absolute ranges ordered', () => {
  const ctx = makeContext();
  const sink = new TrackingSink({ channels: CH, sampleRate: SR, container: 'wav' });
  convert({ source: ctx.source(), target: ctx.target, gainPolicy: ctx.policy, readFrames: 64, sink });
  let cursor = 0;
  for (const entry of sink.writeLog) {
    assert.equal(entry.ok, true);
    assert.equal(entry.startFrame, cursor);
    cursor += entry.frames;
  }
  assert.equal(cursor, ctx.fx.totalFrames);
});
