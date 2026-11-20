import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWavHeader,
  patchWavSizes,
  encodeWavIntegers,
  encodeWavFloats,
  parseWavHeader,
  decodeWavSamples,
  readWavIntegerCode,
} from '../src/wav.js';
import { RawSource } from '../src/io/sources.js';

function makeWav({ bits, kind = 'pcm', channels = 2, sampleRate = 48000, frames, payload }) {
  const header = buildWavHeader({ sampleRate, channels, bits, kind, frames });
  const file = new Uint8Array(header.dataOffset + payload.length);
  file.set(header.bytes);
  patchWavSizes(file, header.patches, { dataSize: payload.length, frames });
  file.set(payload, header.dataOffset);
  return file;
}

test('integer WAV depth round-trips codes exactly (8/16/24/32)', () => {
  for (const bits of [8, 16, 24, 32]) {
    const frames = 11;
    const channels = 2;
    const scale = Math.pow(2, bits - 1);
    const codes = new Int32Array(frames * channels);
    for (let i = 0; i < codes.length; i++) {
      codes[i] = Math.max(-scale, Math.min(scale - 1, Math.round(Math.sin(i) * (scale - 1))));
    }
    const enc = encodeWavIntegers(codes, bits);
    const file = makeWav({ bits, channels, frames, payload: enc.bytes });
    const header = parseWavHeader(file);
    assert.equal(header.kind, 'pcm', `kind ${bits}`);
    assert.equal(header.bitsPerSample, bits);
    assert.equal(header.channels, channels);
    assert.equal(header.totalFrames, frames);
    assert.equal(header.bytesPerSample, bits / 8);
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < channels; c++) {
        assert.equal(readWavIntegerCode(header, file, f, c), codes[f * channels + c], `${bits}-bit frame ${f} ch ${c}`);
      }
    }
    const norm = decodeWavSamples(header, file, frames);
    for (let i = 0; i < codes.length; i++) assert.equal(norm[i], codes[i] / scale);
  }
});

test('float WAV 32/64 keeps exact bit patterns including -0', () => {
  for (const bits of [32, 64]) {
    const samples = new Float64Array([0.5, -0.25, -0, NaN, Infinity, -Infinity]);
    const enc = encodeWavFloats(samples, bits);
    const file = makeWav({ bits, kind: 'float', channels: 2, frames: 3, payload: enc.bytes });
    const header = parseWavHeader(file);
    assert.equal(header.kind, 'float');
    assert.equal(header.container, 'RIFF');
    assert.equal(header.subFormat, 'FLOAT');
    const out = decodeWavSamples(header, file, 3);
    assert.equal(out[0], 0.5);
    assert.equal(out[1], -0.25);
    assert.equal(Object.is(out[2], -0), true, `-0 at ${bits} bits`);
    assert.ok(Number.isNaN(out[3]));
    assert.equal(out[4], Infinity);
    assert.equal(out[5], -Infinity);
  }
});

test('header writes little-endian 24-bit bytes', () => {
  const codes = Int32Array.of(1, -1, 0x7fffff, -0x800000);
  const enc = encodeWavIntegers(codes, 24);
  assert.deepEqual([...enc.bytes.slice(0, 3)], [0x01, 0x00, 0x00]);
  assert.deepEqual([...enc.bytes.slice(3, 6)], [0xff, 0xff, 0xff]);
  assert.deepEqual([...enc.bytes.slice(6, 9)], [0xff, 0xff, 0x7f]);
  assert.deepEqual([...enc.bytes.slice(9, 12)], [0x00, 0x00, 0x80]);
});

test('RF64 header stays parseable and stores 64-bit sizes low-word-first', () => {
  const frames = 2;
  const payload = encodeWavIntegers(Int32Array.of(1, 2, 3, 4), 16).bytes;
  const header = buildWavHeader({ sampleRate: 96000, channels: 2, bits: 16, frames, forceRF64: true });
  assert.ok(header.rf64);
  const file = new Uint8Array(header.dataOffset + payload.length);
  file.set(header.bytes);
  file.set(payload, header.dataOffset);
  patchWavSizes(file, header.patches, { dataSize: payload.length, frames });
  const parsed = parseWavHeader(file);
  assert.equal(parsed.container, 'RF64');
  assert.equal(parsed.totalFrames, frames);
  assert.equal(parsed.dataSize, payload.length);
  assert.equal(parsed.sampleRate, 96000);
  // ds64 data-size low word at the documented offset.
  const dv = new DataView(file.buffer);
  assert.equal(dv.getUint32(header.patches.ds64Data, true), payload.length);
  assert.equal(dv.getUint32(header.patches.ds64Data + 4, true), 0);
});

test('big-endian raw 24-bit input decodes with correct sign and byte order', () => {
  const vals = [1, -1, 8388607, -8388608, 256, -256, 65536, -65536];
  const bytes = new Uint8Array(vals.length * 3);
  vals.forEach((v, i) => {
    const u = v & 0xffffff;
    bytes[i * 3] = (u >> 16) & 0xff;
    bytes[i * 3 + 1] = (u >> 8) & 0xff;
    bytes[i * 3 + 2] = u & 0xff;
  });
  const src = new RawSource(bytes, { format: 's24be', channels: 2, sampleRate: 48000 });
  const samples = src.read(0, 4);
  vals.forEach((v, i) => assert.equal(samples[i] * 8388608, v, `sample ${i}`));
});

test('little-endian raw agrees with big-endian raw of the same codes', () => {
  const vals = [1, -1, 8388607, -8388608, 256, -256, 65536, -65536];
  const be = new Uint8Array(vals.length * 3);
  const le = new Uint8Array(vals.length * 3);
  vals.forEach((v, i) => {
    const u = v & 0xffffff;
    be[i * 3] = (u >> 16) & 0xff;
    be[i * 3 + 1] = (u >> 8) & 0xff;
    be[i * 3 + 2] = u & 0xff;
    le[i * 3] = u & 0xff;
    le[i * 3 + 1] = (u >> 8) & 0xff;
    le[i * 3 + 2] = (u >> 16) & 0xff;
  });
  const a = new RawSource(be, { format: 's24be', channels: 2, sampleRate: 48000 }).read(0, 4);
  const b = new RawSource(le, { format: 's24le', channels: 2, sampleRate: 48000 }).read(0, 4);
  assert.deepEqual([...a], [...b]);
});
