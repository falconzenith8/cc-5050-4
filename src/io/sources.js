// Random-access input sources. Everything downstream reads interleaved
// float64 blocks by frame index, so the converter never has to hold a whole
// file in memory and block boundaries never leak into results.
//
// Sources:
//   * WavSource   – any WAV/RF64 we can parse (PCM + float, any depth)
//   * RawSource   – headerless integer/float PCM with explicit format
//   * MemorySource– an in-memory Float64Array (tests, fixtures, previews)

import { parseWavHeader, decodeWavSamples } from '../wav.js';

export class WavSource {
  constructor(bytes, label = 'wav') {
    this.bytes = bytes;
    this.label = label;
    this.header = parseWavHeader(bytes);
    this.channels = this.header.channels;
    this.sampleRate = this.header.sampleRate;
    this.frames = this.header.totalFrames;
    this.declaredFrames = this.header.declaredFrames;
    this.kind = this.header.kind;
    this.bits = this.header.bitsPerSample;
    this.validBits = this.header.validBits;
    this.subFormat = this.header.subFormat;
    this.truncated = !!this.header.truncated || this.frames < this.declaredFrames;
  }

  read(startFrame, frames) {
    const n = Math.min(frames, this.frames - startFrame);
    if (n <= 0) return new Float64Array(0);
    return decodeWavSamples(this.header, this.bytes, n, startFrame);
  }

  describe() {
    return {
      kind: 'wav',
      container: this.header.container,
      sampleFormat: this.kind,
      bitsPerSample: this.bits,
      validBits: this.validBits,
      sampleRate: this.sampleRate,
      channels: this.channels,
      frames: this.frames,
      declaredFrames: this.declaredFrames,
      duration: this.frames / this.sampleRate,
      truncated: this.truncated,
    };
  }
}

const RAW_FORMATS = new Map([
  ['u8', { kind: 'pcm', bits: 8, signed: false }],
  ['s16le', { kind: 'pcm', bits: 16, signed: true, endian: 'le' }],
  ['s16be', { kind: 'pcm', bits: 16, signed: true, endian: 'be' }],
  ['s24le', { kind: 'pcm', bits: 24, signed: true, endian: 'le' }],
  ['s24be', { kind: 'pcm', bits: 24, signed: true, endian: 'be' }],
  ['s32le', { kind: 'pcm', bits: 32, signed: true, endian: 'le' }],
  ['s32be', { kind: 'pcm', bits: 32, signed: true, endian: 'be' }],
  ['f32le', { kind: 'float', bits: 32, endian: 'le' }],
  ['f32be', { kind: 'float', bits: 32, endian: 'be' }],
  ['f64le', { kind: 'float', bits: 64, endian: 'le' }],
  ['f64be', { kind: 'float', bits: 64, endian: 'be' }],
]);

export function rawFormatInfo(name) {
  const f = RAW_FORMATS.get(name);
  if (!f) throw new Error(`unknown raw format ${name} (try ${[...RAW_FORMATS.keys()].join(', ')})`);
  return f;
}

export class RawSource {
  constructor(bytes, { format, channels, sampleRate, label = 'raw' }) {
    const f = rawFormatInfo(format);
    this.bytes = bytes;
    this.format = format;
    this.fmt = f;
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.label = label;
    this.kind = f.kind;
    this.bits = f.bits;
    this.headerBytes = 0;
    this.frames = Math.floor(bytes.length / ((f.bits / 8) * channels));
  }

  read(startFrame, frames) {
    const { bits, kind } = this.fmt;
    const width = bits / 8;
    const le = this.fmt.endian !== 'be';
    const n = Math.max(0, Math.min(frames, this.frames - startFrame));
    const out = new Float64Array(n * this.channels);
    if (kind === 'pcm') {
      const scale = Math.pow(2, bits - 1);
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < this.channels; c++) {
          const o = ((startFrame + i) * this.channels + c) * width;
          out[i * this.channels + c] = readInt(this.bytes, o, bits, this.fmt.signed, le) / scale;
        }
      }
    } else {
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < this.channels; c++) {
          const o = ((startFrame + i) * this.channels + c) * width;
          out[i * this.channels + c] = readFloat(this.bytes, o, bits, le);
        }
      }
    }
    return out;
  }

  describe() {
    const h = this.describeHeader ? this.describeHeader() : null;
    return {
      kind: 'raw',
      sampleFormat: this.kind,
      rawFormat: this.format,
      bitsPerSample: this.bits,
      sampleRate: this.sampleRate,
      channels: this.channels,
      frames: this.frames,
      duration: this.frames / this.sampleRate,
      headerBytes: 0,
      h,
    };
  }
}

export class MemorySource {
  constructor(samples, { channels, sampleRate, label = 'memory', nonFiniteIndices = null }) {
    this.samples = samples;
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.label = label;
    this.kind = 'float';
    this.bits = 64;
    this.frames = samples.length / channels;
    this.nonFiniteIndices = nonFiniteIndices;
  }

  read(startFrame, frames) {
    const n = Math.max(0, Math.min(frames, this.frames - startFrame));
    return this.samples.slice(startFrame * this.channels, (startFrame + n) * this.channels);
  }

  describe() {
    return {
      kind: 'memory',
      sampleFormat: 'float',
      bitsPerSample: 64,
      sampleRate: this.sampleRate,
      channels: this.channels,
      frames: this.frames,
      duration: this.frames / this.sampleRate,
    };
  }
}

function readInt(bytes, o, bits, signed, le) {
  if (bits === 8) return signed ? (bytes[o] << 24) >> 24 : bytes[o] - 128;
  if (bits === 16) return le ? (bytes[o] | (bytes[o + 1] << 8)) << 16 >> 16 : (bytes[o] << 8 | bytes[o + 1]) << 16 >> 16;
  if (bits === 24) {
    let v = le
      ? bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)
      : (bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2];
    if (v & 0x800000) v -= 0x1000000;
    return v;
  }
  if (bits === 32) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return dv.getInt32(o, le);
  }
  throw new Error(`raw: unsupported integer width ${bits}`);
}

function readFloat(bytes, o, bits, le) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return bits === 32 ? dv.getFloat32(o, le) : dv.getFloat64(o, le);
}
