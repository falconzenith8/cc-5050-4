// Exercises the browser-facing code paths (BlobSource + convertAsync +
// verifyExport) in Node, using Blob and a minimal BlobSource-compatible reader.
// This does not replace a real browser test; it proves the modules the page
// imports are consistent and the async driver matches the sync one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { convert, convertAsync, Uint8Sink } from '../src/convert.js';
import { verifyExport } from '../src/verify.js';
import { BlobSource } from '../public/blob-source.js';
import { MemorySource } from '../src/io/sources.js';
import { buildWavHeader, patchWavSizes, encodeWavFloats } from '../src/wav.js';
import { tailThenTransient } from '../src/fixtures.js';
import { decodeFlac } from '../src/flac/decode.js';

function wavFloatFile(samples, channels, sampleRate) {
  const frames = samples.length / channels;
  const header = buildWavHeader({ sampleRate, channels, bits: 64, kind: 'float', frames });
  const enc = encodeWavFloats(samples, 64);
  const file = new Uint8Array(header.dataOffset + enc.bytes.length);
  file.set(header.bytes);
  patchWavSizes(file, header.patches, { dataSize: enc.bytes.length, frames });
  file.set(enc.bytes, header.dataOffset);
  return file;
}

test('BlobSource reads a WAV slice-by-slice and async conversion matches sync', async () => {
  const { samples, channels, sampleRate } = tailThenTransient({ quietSeconds: 0.06, afterSeconds: 0.02, transientFrames: 8 });
  const file = wavFloatFile(samples, channels, sampleRate);
  const blob = new Blob([file]);
  const src = new BlobSource(blob, { name: 'fixture.wav' });
  await src.ready();
  assert.equal(src.frames, samples.length / channels);
  assert.equal(src.channels, channels);

  const target = { container: 'flac', sampleFormat: 'pcm', bits: 16, dither: 'tpdf', seed: 123 };
  const policy = { mode: 'scan', targetDb: -1 };

  const sinkA = new Uint8Sink();
  const asyncResult = await convertAsync({ source: src, target, gainPolicy: policy, readFrames: 777, flacBlockSize: 512, sink: sinkA });
  const asyncBytes = sinkA.result().slice();

  const syncResult = convert({
    source: new MemorySource(samples, { channels, sampleRate }),
    target,
    gainPolicy: policy,
    readFrames: 777,
    flacBlockSize: 512,
  });
  assert.deepEqual(Buffer.from(asyncBytes), Buffer.from(syncResult.bytes.slice()), 'async BlobSource output differs from sync');
  assert.equal(asyncResult.report.output.frames, syncResult.report.output.frames);

  // The same verifier the page calls.
  const dec = decodeFlac(asyncBytes);
  const v = verifyExport({
    bytes: asyncBytes,
    container: 'flac',
    expected: { codes: dec.audio },
    report: asyncResult.report,
  });
  assert.ok(v.ok, JSON.stringify(v.checks.filter((c) => !c.ok)));
});

test('BlobSource reads headerless raw input', async () => {
  const frames = 64;
  const channels = 2;
  const bytes = new Uint8Array(frames * channels * 3);
  for (let i = 0; i < frames * channels; i++) {
    const v = (i * 4099) % 100000 - 50000;
    const u = v & 0xffffff;
    bytes[i * 3] = u & 0xff;
    bytes[i * 3 + 1] = (u >> 8) & 0xff;
    bytes[i * 3 + 2] = (u >> 16) & 0xff;
  }
  const src = new BlobSource(new Blob([bytes]), { format: 's24le' });
  src.channels = channels;
  src.sampleRate = 48000;
  await src.ready();
  assert.equal(src.frames, frames);
  const block = await src.read(10, 5);
  assert.equal(block.length, 5 * channels);
  // Sample index 20 is frame 10, channel 0.
  assert.equal(block[0], (((20 * 4099) % 100000) - 50000) / 8388608);
});
