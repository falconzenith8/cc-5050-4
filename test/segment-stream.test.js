// Segment index and concatenator tests.
//
// These cover the resumable-write contract directly:
//
//   * only successfully written absolute frame ranges become retrievable;
//   * a failed final partial block leaves the index short, never announced as
//     a complete track;
//   * the concatenator pulls real bytes across a part boundary and the result
//     aligns with the uninterrupted oracle;
//   * the first duplicated or dropped sample at a seam is located and named.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SegmentIndex, SegmentConcatenator, firstDivergence, locateSeamDefect } from '../src/io/segment-stream.js';

const SR = 48000;
const CH = 2;

function pcmPart(startFrame, frames, channels = CH) {
  const codes = new Int32Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) codes[i * channels + c] = (startFrame + i) * 10 + c;
  }
  const bytes = new Uint8Array(codes.length * 2);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < codes.length; i++) dv.setInt16(i * 2, codes[i], true);
  return { codes, bytes };
}

function mapSink(parts) {
  const bufs = new Map();
  for (const p of parts) bufs.set(p.offset, p.bytes);
  return { bufs, read(off, len) { return this.bufs.get(off).subarray(0, len); } };
}

function decodePcm16(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int32Array(bytes.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, true);
  return out;
}

test('commit records absolute ranges; adjacency keeps distinct parts', () => {
  const idx = new SegmentIndex({ channels: CH, sampleRate: SR, container: 'wav' });
  const a = pcmPart(0, 100);
  const b = pcmPart(100, 50);
  idx.commit(0, 100, 0, a.bytes.length);
  idx.commit(100, 50, 9000, b.bytes.length);
  assert.equal(idx.intervals.length, 2, 'adjacent parts must not merge');
  assert.equal(idx.contiguousEnd, 150);
  assert.deepEqual(idx.summary().intervals.map((iv) => [iv.start, iv.end]), [[0, 100], [100, 150]]);
  assert.ok(idx.isRangeAvailable(0, 150));
  assert.equal(idx.isRangeAvailable(0, 151), false);
});

test('overlapping retry merges onto the same absolute range', () => {
  const idx = new SegmentIndex({ channels: CH, sampleRate: SR, container: 'wav' });
  idx.commit(0, 100, 0, 400);
  idx.commit(80, 40, 320, 160); // rewrite of frames 80..120
  assert.equal(idx.intervals.length, 1);
  assert.deepEqual([idx.intervals[0].start, idx.intervals[0].end], [0, 120]);
  assert.equal(idx.contiguousEnd, 120);
});

test('a failed final partial block cannot be announced as complete', () => {
  const total = 250;
  const idx = new SegmentIndex({ channels: CH, sampleRate: SR, container: 'wav' });
  idx.commit(0, 192, 0, 192 * 4);
  idx.recordFailure(192, 58, new Error('disk full on tail'));
  const avail = idx.availability(total);
  assert.equal(avail.complete, false);
  assert.equal(avail.committedFrames, 192);
  assert.equal(avail.missingFrom, 192);
  assert.equal(avail.missingFrames, 58);
  assert.deepEqual(avail.gaps, [{ start: 192, end: 250 }]);
  assert.equal(idx.failedWrites.length, 1);
  assert.equal(idx.intervalFor(200), null, 'unwritten frame is not retrievable');
  assert.ok(idx.intervalFor(191), 'committed prefix stays retrievable');
});

test('rollbackTo drops ranges at and after a frame for a clean retry', () => {
  const idx = new SegmentIndex({ channels: CH, sampleRate: SR, container: 'wav' });
  // 4 bytes per frame (16-bit stereo); keep the byte density honest.
  idx.commit(0, 100, 0, 400);
  idx.commit(100, 60, 4000, 240);
  idx.rollbackTo(100);
  assert.equal(idx.contiguousEnd, 100);
  assert.equal(idx.intervals.length, 1);

  // Partial rollback scales the retained byte length by frame count.
  idx.commit(100, 60, 4000, 240);
  idx.rollbackTo(130);
  assert.equal(idx.intervals.length, 2);
  assert.equal(idx.contiguousEnd, 130);
  assert.equal(idx.intervals[1].byteLength, 120, '30 frames * 4 bytes');
});

test('concatenator pulls real bytes across a part seam and reconstructs the oracle', () => {
  const a = pcmPart(0, 100);
  const b = pcmPart(100, 100);
  const sink = mapSink([
    { offset: 0, bytes: a.bytes },
    { offset: 5000, bytes: b.bytes },
  ]);
  const idx = new SegmentIndex({ channels: CH, sampleRate: SR, container: 'wav' });
  idx.commit(0, 100, 0, a.bytes.length);
  idx.commit(100, 100, 5000, b.bytes.length);

  const cat = new SegmentConcatenator(idx, sink, decodePcm16);
  const seam = cat.pullAcrossSeam(100, 3, 3);
  assert.equal(seam.crossesPartBoundary, true);
  assert.notEqual(seam.leftPart, seam.seamPart);
  assert.deepEqual([...seam.left.slice(-2)], [990, 991]);
  assert.deepEqual([...seam.right.slice(0, 2)], [1000, 1001]);

  const full = cat.pull(0, 200);
  for (let f = 0; f < 200; f++) {
    for (let c = 0; c < CH; c++) {
      assert.equal(full.samples[f * CH + c], f * 10 + c, `frame ${f} ch ${c}`);
    }
  }
  assert.equal(full.origin[99], 0);
  assert.equal(full.origin[100], 1, 'origin changes exactly at the part boundary');

  const payload = cat.assemblePayload();
  assert.equal(payload.length, a.bytes.length + b.bytes.length);
});

test('pull refuses a frame the index never committed', () => {
  const idx = new SegmentIndex({ channels: CH, sampleRate: SR, container: 'wav' });
  const a = pcmPart(0, 50);
  const sink = mapSink([{ offset: 0, bytes: a.bytes }]);
  idx.commit(0, 50, 0, a.bytes.length);
  const cat = new SegmentConcatenator(idx, sink, decodePcm16);
  assert.throws(() => cat.pull(40, 20), /not committed/);
});

test('firstDivergence reports absolute frame and channel', () => {
  const expected = Int32Array.of(1, 2, 3, 4, 5, 6);
  const actual = Int32Array.of(1, 2, 3, 9, 5, 6);
  const d = firstDivergence(expected, actual, { startFrame: 10, channels: 2 });
  assert.deepEqual(d, { index: 3, frame: 11, channel: 1, expected: 4, actual: 9 });
  assert.equal(firstDivergence(expected, expected, { channels: 2 }), null);
});

test('seam locator names a duplicated sample and a dropped sample separately', () => {
  const N = 200;
  const oracle = new Int32Array(N * CH);
  for (let f = 0; f < N; f++) for (let c = 0; c < CH; c++) oracle[f * CH + c] = f * 10 + c;

  // Duplicate frame 99 at position 100.
  const dup = new Int32Array(oracle.length);
  dup.set(oracle.subarray(0, 100 * CH));
  dup.set(oracle.subarray(99 * CH, 199 * CH), 100 * CH);
  const dupResult = locateSeamDefect(oracle, dup, { seamFrame: 100, channels: CH, searchRadius: 24 });
  assert.equal(dupResult.kind, 'duplicated-sample');
  assert.equal(dupResult.lag, 1);
  assert.equal(dupResult.firstDivergence.frame, 100);

  // Drop frame 100: later content shifts one frame earlier.
  const dropped = new Int32Array(oracle.length);
  dropped.set(oracle.subarray(0, 100 * CH));
  dropped.set(oracle.subarray(101 * CH, 200 * CH), 100 * CH);
  dropped.set(oracle.subarray(199 * CH, 200 * CH), 199 * CH);
  const dropResult = locateSeamDefect(oracle, dropped, { seamFrame: 100, channels: CH, searchRadius: 24 });
  assert.equal(dropResult.kind, 'dropped-sample');
  assert.equal(dropResult.lag, -1);
  assert.equal(dropResult.firstDivergence.frame, 100);

  assert.equal(locateSeamDefect(oracle, oracle, { seamFrame: 100, channels: CH }).kind, 'clean');
});
