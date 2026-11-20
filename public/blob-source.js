// Browser input sources: read a File/Blob in slices so multi-GB inputs never
// have to be materialised. The returned source is async; convertAsync drives
// the same core as the CLI.

import { parseWavHeader, decodeWavSamples } from '../src/wav.js';
import { rawFormatInfo } from '../src/io/sources.js';

export class BlobSource {
  /**
   * @param {Blob} blob
   * @param {object} [opts] raw format descriptor or {wav:true}
   */
  constructor(blob, opts = {}) {
    this.blob = blob;
    this.name = blob.name || opts.name || 'input';
    this.rawFormat = opts.format || null;
    this._ready = null;
  }

  async ready() {
    if (!this._ready) this._ready = this._init();
    return this._ready;
  }

  async _init() {
    if (this.rawFormat) {
      const f = rawFormatInfo(this.rawFormat);
      if (!this.channels) {
        // caller must set channels/sampleRate before ready() if raw
      }
      this.kind = 'raw';
      this.fmt = f;
      this.bits = f.bits;
      this.frames = Math.floor(this.blob.size / ((f.bits / 8) * this.channels));
      this.declaredFrames = this.frames;
      this.sampleRate = this.sampleRate || 48000;
      this.dataOffset = 0;
      this.blockAlign = (f.bits / 8) * this.channels;
      return this;
    }
    const headSize = Math.min(this.blob.size, 1 << 20);
    const head = new Uint8Array(await this.blob.slice(0, headSize).arrayBuffer());
    const header = parseWavHeader(head);
    this.header = header;
    this.kind = 'wav';
    this.channels = header.channels;
    this.sampleRate = header.sampleRate;
    this.bits = header.bitsPerSample;
    this.validBits = header.validBits;
    this.subFormat = header.subFormat;
    this.sampleFormat = header.kind;
    this.container = header.container;
    this.dataOffset = header.dataOffset;
    this.blockAlign = header.blockAlign;
    this.declaredFrames = header.declaredFrames;
    this.frames = Math.min(header.totalFrames, Math.floor((this.blob.size - header.dataOffset) / header.blockAlign));
    this.truncated = this.frames < header.declaredFrames;
    return this;
  }

  async read(startFrame, frames) {
    await this.ready();
    const n = Math.max(0, Math.min(frames, this.frames - startFrame));
    const byteStart = this.dataOffset + startFrame * this.blockAlign;
    const byteLen = n * this.blockAlign;
    const buf = new Uint8Array(await this.blob.slice(byteStart, byteStart + byteLen).arrayBuffer());
    if (this.kind === 'raw') {
      return decodeRaw(buf, this.fmt, this.channels, this.rawFormat);
    }
    const fakeHeader = { ...this.header, dataOffset: 0 };
    return decodeWavSamples(fakeHeader, buf, n, 0, this.channels);
  }

  describe() {
    return {
      kind: this.kind,
      name: this.name,
      fileBytes: this.blob.size,
      container: this.container,
      sampleFormat: this.kind === 'raw' ? this.fmt.kind : this.header.kind,
      bitsPerSample: this.bits,
      validBits: this.validBits,
      sampleRate: this.sampleRate,
      channels: this.channels,
      frames: this.frames,
      declaredFrames: this.declaredFrames,
      duration: this.frames / this.sampleRate,
      truncated: !!this.truncated,
      rawFormat: this.rawFormat,
    };
  }
}

function decodeRaw(bytes, fmt, channels, name) {
  const width = fmt.bits / 8;
  const n = Math.floor(bytes.length / (width * channels));
  const out = new Float64Array(n * channels);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = fmt.endian !== 'be';
  const scale = fmt.kind === 'pcm' ? Math.pow(2, fmt.bits - 1) : 1;
  for (let i = 0; i < n * channels; i++) {
    const o = i * width;
    let v;
    if (fmt.kind === 'float') v = fmt.bits === 32 ? dv.getFloat32(o, le) : dv.getFloat64(o, le);
    else if (fmt.bits === 8) v = (fmt.signed ? dv.getInt8(o) : dv.getUint8(o) - 128) / scale;
    else if (fmt.bits === 16) v = dv.getInt16(o, le) / scale;
    else if (fmt.bits === 24) {
      let x = le
        ? dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16)
        : (dv.getUint8(o) << 16) | (dv.getUint8(o + 1) << 8) | dv.getUint8(o + 2);
      if (x & 0x800000) x -= 0x1000000;
      v = x / scale;
    } else if (fmt.bits === 32) v = dv.getInt32(o, le) / scale;
    else throw new Error(`raw: unsupported ${name}`);
    out[i] = v;
  }
  return out;
}
