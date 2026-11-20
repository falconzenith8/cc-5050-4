import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeContainer, compareDecoded } from '../src/compare.js';
import { convert, Uint8Sink } from '../src/convert.js';
import { MemorySource } from '../src/io/sources.js';
import { tailThenTransient } from '../src/fixtures.js';

function produce(container, bits, samples, channels, extra = {}) {
  const sink = new Uint8Sink();
  const res = convert({
    source: new MemorySource(samples, { channels, sampleRate: 48000 }),
    target: { container, sampleFormat: 'pcm', bits, dither: 'tpdf', seed: 0x1234, ...extra },
    gainPolicy: { mode: 'fixed', gainDb: -1 },
    readFrames: 4096,
    flacBlockSize: 1024,
    sink,
  });
  return { bytes: sink.result().slice(), report: res.report };
}

test('WAV and FLAC at the same depth decode to identical codes', () => {
  const { samples, channels } = tailThenTransient({ quietSeconds: 0.03, afterSeconds: 0.01, transientFrames: 8 });
  for (const bits of [16, 24]) {
    const wav = produce('wav', bits, samples, channels);
    const flac = produce('flac', bits, samples, channels);
    const a = decodeContainer(wav.bytes, 'wav');
    const b = decodeContainer(flac.bytes, 'flac');
    const cmp = compareDecoded(a, b);
    assert.ok(cmp.identical, `${bits}-bit: ${cmp.detail}`);
    assert.equal(cmp.maxAbsDiff, 0);
    for (let i = 0; i < cmp.diff.length; i++) assert.equal(cmp.diff[i], 0);
  }
});

test('compareDecoded reports a real mismatch with location', () => {
  const a = { kind: 'pcm', data: Int32Array.of(10, 20, 30, 40), channels: 2, bits: 16, frames: 2, sampleRate: 48000 };
  const b = { kind: 'pcm', data: Int32Array.of(10, 20, 31, 40), channels: 2, bits: 16, frames: 2, sampleRate: 48000 };
  const cmp = compareDecoded(a, b);
  assert.equal(cmp.identical, false);
  assert.equal(cmp.mismatches, 1);
  assert.deepEqual(cmp.firstMismatch, { frame: 1, channel: 0 });
  assert.equal(cmp.diff[2], -1 / 32768);
});

test('compareDecoded flags mismatched lengths even when the overlap matches', () => {
  const a = { kind: 'pcm', data: Int32Array.of(1, 2, 3, 4), channels: 2, bits: 16, frames: 2, sampleRate: 48000 };
  const b = { kind: 'pcm', data: Int32Array.of(1, 2), channels: 2, bits: 16, frames: 1, sampleRate: 48000 };
  const cmp = compareDecoded(a, b);
  assert.equal(cmp.mismatches, 0);
  assert.equal(cmp.lengthMatch, false);
  assert.equal(cmp.identical, false);
});
