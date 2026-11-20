// Writes the reproducible fixture set: each file isolates one of the hard
// cases the tool must get right, and the manifest records the expected sample
// values so tests can assert on them without decoding guesswork.

import fs from 'node:fs';
import path from 'node:path';
import { buildWavHeader, patchWavSizes, encodeWavIntegers, encodeWavFloats } from '../src/wav.js';
import { tailThenTransient, extremes, mulberry32, SR } from '../src/fixtures.js';

function writeWavInt(dir, name, { sampleRate, channels, bits, codes }) {
  const frames = codes.length / channels;
  const header = buildWavHeader({ sampleRate, channels, bits, frames });
  const enc = encodeWavIntegers(codes, bits);
  const file = new Uint8Array(header.dataOffset + enc.bytes.length);
  file.set(header.bytes);
  patchWavSizes(file, header.patches, { dataSize: enc.bytes.length, frames });
  file.set(enc.bytes, header.dataOffset);
  const p = path.join(dir, name);
  fs.writeFileSync(p, file);
  return { file: p, bytes: file.length, frames };
}

function writeWavFloat(dir, name, { sampleRate, channels, bits, samples }) {
  const frames = samples.length / channels;
  const header = buildWavHeader({ sampleRate, channels, bits, kind: 'float', frames });
  const enc = encodeWavFloats(samples, bits);
  const file = new Uint8Array(header.dataOffset + enc.bytes.length);
  file.set(header.bytes);
  patchWavSizes(file, header.patches, { dataSize: enc.bytes.length, frames });
  file.set(enc.bytes, header.dataOffset);
  const p = path.join(dir, name);
  fs.writeFileSync(p, file);
  return { file: p, bytes: file.length, frames };
}

function writeRaw(dir, name, { chans, bits, signed, samples }) {
  const width = bits / 8;
  const buf = Buffer.alloc(samples.length * width);
  const max = Math.pow(2, bits - 1) - 1;
  const min = -Math.pow(2, bits - 1);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(min, Math.min(max, Math.round(samples[i] * Math.pow(2, bits - 1))));
    if (bits === 8) buf.writeInt8(v, i);
    else if (bits === 16) buf.writeInt16LE(v, i * 2);
    else if (bits === 24) {
      buf.writeUInt8(v & 0xff, i * 3);
      buf.writeUInt8((v >> 8) & 0xff, i * 3 + 1);
      buf.writeUInt8((v >> 16) & 0xff, i * 3 + 2);
    } else buf.writeInt32LE(v, i * 4);
  }
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  void chans;
  return { file: p, bytes: buf.length, frames: samples.length / chans };
}

export function makeFixtureSet(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const made = [];
  const manifest = { sampleRate: SR, files: [], expected: {} };

  // 1) quiet tail then full-scale transient, 24-bit stereo
  const t = tailThenTransient({ quietSeconds: 0.5, quietDb: -90, transientFrames: 24, afterSeconds: 0.1, channels: 2 });
  const tInt = new Int32Array(t.samples.length);
  for (let i = 0; i < t.samples.length; i++) {
    tInt[i] = Math.max(-8388608, Math.min(8388607, Math.round(t.samples[i] * 8388608)));
  }
  const tFile = writeWavInt(dir, 'tail-then-transient-24.wav', { sampleRate: SR, channels: 2, bits: 24, codes: tInt });
  made.push({ ...tFile, note: 'quiet 1 kHz (-90 dBFS) then full-scale transient, 24-bit stereo' });
  manifest.files.push({ name: 'tail-then-transient-24.wav', role: 'tail-then-transient', bits: 24, channels: 2, frames: tFile.frames, peakFrame: t.peakFrame, quietFrames: t.quietFrames });
  manifest.expected['tail-then-transient-24.wav'] = { peakFrame: t.peakFrame, quietFrames: t.quietFrames, transientFrames: t.transientFrames };

  // 2) same shape but 32-bit float, with non-finite values planted mid-file
  const tf = Float64Array.from(t.samples);
  const nanAt = tf.length - 4;
  tf[nanAt] = NaN;
  tf[nanAt + 1] = Infinity;
  tf[nanAt + 2] = -Infinity;
  const tfFile = writeWavFloat(dir, 'tail-then-transient-f32.wav', { sampleRate: SR, channels: 2, bits: 32, samples: tf });
  made.push({ ...tfFile, note: 'as above plus NaN/+Inf/-Inf in the tail, 32-bit float' });
  manifest.files.push({ name: 'tail-then-transient-f32.wav', role: 'non-finite', bits: 32, channels: 2, frames: tfFile.frames, nanFrame: Math.floor(nanAt / 2) });
  manifest.expected['tail-then-transient-f32.wav'] = { firstNonFiniteFrame: Math.floor(nanAt / 2) };

  // 3) extremes: rails, over-rails, zeros, LSB probes, non-finite, -0
  const ex = extremes();
  const exInt = new Int32Array(ex.samples.length);
  for (let i = 0; i < ex.samples.length; i++) {
    const v = ex.samples[i];
    exInt[i] = Number.isFinite(v) ? Math.max(-8388608, Math.min(8388607, Math.round(v * 8388608))) : 0;
  }
  const exFile = writeWavInt(dir, 'extremes-24.wav', { sampleRate: SR, channels: 2, bits: 24, codes: exInt });
  made.push({ ...exFile, note: 'rails, over-rails, zeros, 2^-23 probes, non-finite -> 24-bit' });
  manifest.files.push({ name: 'extremes-24.wav', role: 'extremes', bits: 24, channels: 2, frames: exFile.frames });
  manifest.expected['extremes-24.wav'] = { rows: ex.rows };

  // 4) 32-bit float extremes: keeps over-rails and non-finite as-is
  const exF = new Float64Array(ex.samples.length);
  exF.set(ex.samples);
  const exfFile = writeWavFloat(dir, 'extremes-f32.wav', { sampleRate: SR, channels: 2, bits: 32, samples: exF });
  made.push({ ...exfFile, note: 'extremes kept as float: over-rails, NaN, +-Inf, -0' });
  manifest.files.push({ name: 'extremes-f32.wav', role: 'extremes-float', bits: 32, channels: 2, frames: exfFile.frames });

  // 5) raw interleaved big-endian signed 24 for byte-order checks
  const rawBytes = Buffer.alloc(8 * 3 * 2);
  // +1 LSB, -1 LSB, +max, -max as 24-bit BE, two channels
  const vals = [1, -1, 8388607, -8388608, 256, -256, 65536, -65536];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i] & 0xffffff;
    rawBytes.writeUInt8((v >> 16) & 0xff, i * 3);
    rawBytes.writeUInt8((v >> 8) & 0xff, i * 3 + 1);
    rawBytes.writeUInt8(v & 0xff, i * 3 + 2);
  }
  const rawPath = path.join(dir, 'endian-s24be.raw');
  fs.writeFileSync(rawPath, rawBytes);
  made.push({ file: rawPath, bytes: rawBytes.length, note: 'headerless 24-bit BE, LSB probes and rails' });
  manifest.files.push({ name: 'endian-s24be.raw', role: 'endian', bits: 24, channels: 2, frames: 8, rawFormat: 's24be', sampleRate: SR });
  manifest.expected['endian-s24be.raw'] = { codes: vals };

  // 6) deterministic noise, 16-bit mono, for dither statistics and cancellation
  const rnd = mulberry32(0xc0ffee);
  const noise = new Float64Array(2 * SR);
  for (let i = 0; i < noise.length; i++) noise[i] = (rnd() * 2 - 1) * 0.5;
  const noiseFile = writeWavFloat(dir, 'noise-f32.wav', { sampleRate: SR, channels: 1, bits: 32, samples: noise });
  made.push({ ...noiseFile, note: 'seedable noise bed for dither and difference analysis' });
  manifest.files.push({ name: 'noise-f32.wav', role: 'noise', bits: 32, channels: 1, frames: noiseFile.frames });

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  made.push({ file: path.join(dir, 'manifest.json'), note: 'expected values for all fixtures' });
  return made;
}
