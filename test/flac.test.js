import test from 'node:test';
import assert from 'node:assert/strict';
import { FlacEncoder } from '../src/flac/encode.js';
import { FlacDecoder, decodeFlac } from '../src/flac/decode.js';
import { md5Hex } from '../src/flac/md5.js';
import { crc8, crc16 } from '../src/flac/crc.js';

function md5OfCodes(codes, bits, channels) {
  const width = bits <= 8 ? 1 : bits <= 16 ? 2 : bits <= 24 ? 3 : 4;
  const buf = new Uint8Array(codes.length * width);
  let o = 0;
  for (const v of codes) {
    buf[o++] = v & 0xff;
    if (width >= 2) buf[o++] = (v >> 8) & 0xff;
    if (width >= 3) buf[o++] = (v >> 16) & 0xff;
    if (width === 4) buf[o++] = (v >> 24) & 0xff;
  }
  return md5Hex(buf);
}

function roundtrip({ bits, channels, frames, seed = 1, blockSize = 64 }) {
  const codes = new Int32Array(frames * channels);
  const scale = Math.pow(2, bits - 1);
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      // Mix of noise, ramps and silence so fixed/LPC/constant subframes all run.
      const mode = Math.floor(i / 97) % 4;
      let v;
      if (mode === 0) v = Math.round((rnd() * 2 - 1) * (scale - 1));
      else if (mode === 1) v = Math.round(((i % 100) / 100) * (scale - 1));
      else if (mode === 2) v = 0;
      else v = Math.round(Math.sin(i / 17) * (scale - 1));
      codes[i * channels + c] = Math.max(-scale, Math.min(scale - 1, v));
    }
  }
  const enc = new FlacEncoder({ sampleRate: 44100, channels, bits, blockSize });
  const layout = enc.metadataLayout({ comments: ['TEST=1'], totalSamples: frames });
  const parts = [layout.bytes];
  for (let start = 0; start < frames; start += blockSize) {
    const n = Math.min(blockSize, frames - start);
    parts.push(enc.encodeFrame(codes.subarray(start * channels, (start + n) * channels), 0, n));
  }
  const streamInfo = enc.finalStreamInfo();
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  out.set(streamInfo, layout.streamInfoOffset);
  return { bytes: out, codes, md5: enc.md5.hex() };
}

test('CRC-8 matches the FLAC frame-header polynomial check value', () => {
  // CRC-8 (poly 0x07, init 0, not reflected) over "123456789" = 0xF4.
  const data = new TextEncoder().encode('123456789');
  assert.equal(crc8(data), 0xf4);
  // CRC-16 (poly 0x8005, init 0, not reflected) over "123456789" = 0xFEE8,
  // the variant FLAC uses (not the reflected CRC-16/ARC value).
  assert.equal(crc16(data), 0xfee8);
});

test('MD5 matches known vectors', () => {
  assert.equal(md5Hex(new Uint8Array(0)), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5Hex(new TextEncoder().encode('abc')), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(
    md5Hex(new TextEncoder().encode('The quick brown fox jumps over the lazy dog')),
    '9e107d9d372bb6826bd81d3542a419d6',
  );
});

test('FLAC round-trip across bit depths, channel counts and block sizes', () => {
  const matrix = [
    { bits: 8, channels: 1 },
    { bits: 16, channels: 1 },
    { bits: 16, channels: 2 },
    { bits: 24, channels: 2 },
    { bits: 20, channels: 2 },
    { bits: 12, channels: 2 },
    { bits: 32, channels: 2 },
  ];
  for (const { bits, channels } of matrix) {
    for (const blockSize of [16, 64, 257, 4096]) {
      const frames = 400;
      const { bytes, codes, md5 } = roundtrip({ bits, channels, frames, blockSize, seed: bits * 7 + channels });
      const dec = decodeFlac(bytes.slice());
      assert.equal(dec.warnings.length, 0, `${bits}/${channels}/${blockSize}: ${dec.warnings.join('; ')}`);
      assert.equal(dec.md5Ok, true, `${bits}/${channels}/${blockSize}: md5`);
      assert.equal(dec.samples, frames);
      assert.deepEqual(Buffer.from(dec.audio.buffer), Buffer.from(codes.buffer), `${bits}/${channels}/${blockSize} audio`);
      assert.equal(md5, md5OfCodes(codes, bits, channels), `${bits}/${channels}/${blockSize} md5 value`);
    }
  }
});

test('FLAC handles partial final block and single-frame input', () => {
  for (const frames of [1, 2, 3, 15, 16, 17, 4095, 4096, 4097]) {
    const { bytes, codes } = roundtrip({ bits: 16, channels: 2, frames, blockSize: 4096, seed: frames });
    const dec = decodeFlac(bytes.slice());
    assert.equal(dec.samples, frames, `frames ${frames}`);
    assert.deepEqual(Buffer.from(dec.audio.buffer), Buffer.from(codes.buffer), `frames ${frames}`);
  }
});

test('decoder rejects a corrupted CRC', () => {
  const { bytes } = roundtrip({ bits: 16, channels: 2, frames: 300, blockSize: 100, seed: 9 });
  const bad = bytes.slice();
  // Flip a byte well inside the first frame (after the 4-byte metadata tail).
  bad[Math.floor(bad.length / 2)] ^= 0xff;
  const dec = new FlacDecoder(bad);
  dec.readMetadata();
  assert.throws(() => dec.decodeAll({ verifyCRC: true }), /CRC|CRC-16|crc/i);
});

test('FLAC pointwise decode of independent encoders via ffmpeg is checked in the CLI suite', () => {
  // Placeholder keeps intent visible; the real external check runs in
  // test/cli.test.js only when ffmpeg is installed.
  assert.ok(true);
});
