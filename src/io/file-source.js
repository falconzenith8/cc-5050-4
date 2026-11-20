// Node file-backed sources. Reading uses positional fs reads so large files are
// never loaded whole; a block cache keeps the two-pass (analyse then write)
// flow from re-reading most of the file.

import fs from 'node:fs';
import { parseWavHeader, decodeWavSamples } from '../wav.js';
import { rawFormatInfo } from './sources.js';

export class FileSource {
  /** @param {string} path @param {object} [opts] {format, channels, sampleRate} for raw */
  constructor(path, opts = {}) {
    this.path = path;
    this.fd = fs.openSync(path, 'r');
    this.size = fs.fstatSync(this.fd).size;
    this.label = path;
    this._cache = new Map();
    this._cacheBytes = 0;
    this._cacheLimit = opts.cacheBytes ?? 32 * 1024 * 1024;

    if (opts.format) {
      const f = rawFormatInfo(opts.format);
      if (!opts.channels) throw new Error('raw input requires --channels');
      if (!opts.sampleRate) throw new Error('raw input requires --sample-rate');
      this.kind = 'raw';
      this.rawFormat = opts.format;
      this.fmt = f;
      this.bits = f.bits;
      this.channels = opts.channels;
      this.sampleRate = opts.sampleRate;
      this.headerBytes = 0;
      const width = (f.bits / 8) * this.channels;
      this.frames = Math.floor(this.size / width);
      this.declaredFrames = this.frames;
      this.dataOffset = 0;
      this.blockAlign = width;
    } else {
      const head = this._readAt(0, Math.min(this.size, 1 << 20));
      const header = parseWavHeader(head);
      this.kind = 'wav';
      this.header = header;
      this.channels = header.channels;
      this.sampleRate = header.sampleRate;
      this.bits = header.bitsPerSample;
      this.validBits = header.validBits;
      this.subFormat = header.subFormat;
      this.sampleFormat = header.kind;
      this.headerBytes = header.dataOffset;
      this.dataOffset = header.dataOffset;
      this.blockAlign = header.blockAlign;
      this.declaredFrames = header.declaredFrames;
      this.frames = Math.min(header.totalFrames, Math.floor((this.size - header.dataOffset) / header.blockAlign));
      this.truncated = this.frames < header.declaredFrames;
    }
  }

  _readAt(offset, length) {
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const n = fs.readSync(this.fd, buf, got, length - got, offset + got);
      if (n === 0) break;
      got += n;
    }
    return got === length ? buf : buf.subarray(0, got);
  }

  /** Read and decode a frame-range. This is the hot path; keep it simple. */
  read(startFrame, frames) {
    const channels = this.channels;
    const n = Math.max(0, Math.min(frames, this.frames - startFrame));
    const byteStart = this.dataOffset + startFrame * this.blockAlign;
    const byteLen = n * this.blockAlign;
    const key = `${startFrame}:${n}`;
    let cached = this._cache.get(key);
    let bytes;
    if (cached) {
      bytes = cached;
    } else {
      bytes = this._readAt(byteStart, byteLen);
      if (this._cacheBytes + bytes.length < this._cacheLimit) {
        this._cache.set(key, bytes);
        this._cacheBytes += bytes.length;
      }
    }
    if (this.kind === 'raw') {
      return decodeRawBlock(bytes, this.fmt, channels, this.rawFormat);
    }
    // decodeWavSamples expects a header whose dataOffset is 0 for the block.
    const fakeHeader = { ...this.header, dataOffset: 0 };
    return decodeWavSamples(fakeHeader, bytes, n, 0, channels);
  }

  describe() {
    const base = {
      kind: this.kind === 'raw' ? 'raw' : 'wav',
      path: this.path,
      fileBytes: this.size,
      sampleFormat: this.kind === 'raw' ? this.fmt.kind : this.header.kind,
      bitsPerSample: this.bits,
      sampleRate: this.sampleRate,
      channels: this.channels,
      frames: this.frames,
      declaredFrames: this.declaredFrames,
      duration: this.frames / this.sampleRate,
    };
    if (this.kind === 'wav') {
      base.container = this.header.container;
      base.validBits = this.validBits;
      base.subFormat = this.subFormat;
      base.truncated = !!this.truncated;
      base.dataOffset = this.header.dataOffset;
    } else {
      base.rawFormat = this.rawFormat;
    }
    return base;
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

function decodeRawBlock(bytes, fmt, channels, formatName) {
  const width = fmt.bits / 8;
  const n = Math.floor(bytes.length / (width * channels));
  const out = new Float64Array(n * channels);
  const le = fmt.endian !== 'be';
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scale = fmt.kind === 'pcm' ? Math.pow(2, fmt.bits - 1) : 1;
  for (let i = 0; i < n * channels; i++) {
    const o = i * width;
    let v;
    if (fmt.kind === 'float') {
      v = fmt.bits === 32 ? dv.getFloat32(o, le) : dv.getFloat64(o, le);
    } else if (fmt.bits === 8) {
      v = (fmt.signed ? (dv.getInt8(o)) : dv.getUint8(o) - 128) / scale;
    } else if (fmt.bits === 16) {
      v = dv.getInt16(o, le) / scale;
    } else if (fmt.bits === 24) {
      let x = le
        ? dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16)
        : (dv.getUint8(o) << 16) | (dv.getUint8(o + 1) << 8) | dv.getUint8(o + 2);
      if (x & 0x800000) x -= 0x1000000;
      v = x / scale;
    } else if (fmt.bits === 32) {
      v = dv.getInt32(o, le) / scale;
    } else {
      throw new Error(`raw: unsupported ${formatName}`);
    }
    out[i] = v;
  }
  return out;
}
