// FLAC decoder: parses STREAMINFO/Vorbis comments, decodes frames, verifies
// CRCs and optionally the STREAMINFO MD5. The returned audio is interleaved
// Int32Array; bit depth and channel count are reported separately.
//
// Used both by the app's own verification step and by the tests to prove that
// what the encoder wrote is what the encoder meant.

import { BitReader } from './bitio.js';
import { crc8, crc16 } from './crc.js';
import { MD5 } from './md5.js';
import { BLOCK_CODE_SIZES, SAMPLE_RATE_CODE_VALUES, BPS_CODE_VALUES, utf8Size } from './encode.js';

export function readUtf8(r) {
  const b0 = r.readBits(8);
  if ((b0 & 0x80) === 0) return b0;
  let n = 1;
  for (let mask = 0x80; mask && (b0 & mask); mask >>= 1) n++;
  if (n < 2 || n > 8) throw new Error('invalid utf8 coded number');
  let value = b0 & (0xff >> n);
  for (let i = 1; i < n; i++) {
    const b = r.readBits(8);
    if ((b & 0xc0) !== 0x80) throw new Error('invalid utf8 continuation');
    value = value * 64 + (b & 0x3f);
  }
  return value;
}

export class FlacDecoder {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
    this.metadata = [];
    this.streamInfo = null;
    this.vorbisComments = [];
    this.frames = [];
    this.warnings = [];
  }

  _u8() {
    return this.bytes[this.pos++];
  }

  _u16() {
    const v = (this.bytes[this.pos] << 8) | this.bytes[this.pos + 1];
    this.pos += 2;
    return v;
  }

  _u24() {
    const v = (this.bytes[this.pos] << 16) | (this.bytes[this.pos + 1] << 8) | this.bytes[this.pos + 2];
    this.pos += 3;
    return v;
  }

  _u32() {
    const v = ((this.bytes[this.pos] << 24) | (this.bytes[this.pos + 1] << 16) | (this.bytes[this.pos + 2] << 8) | this.bytes[this.pos + 3]) >>> 0;
    this.pos += 4;
    return v;
  }

  readMetadata() {
    const magic = String.fromCharCode(this.bytes[0], this.bytes[1], this.bytes[2], this.bytes[3]);
    if (magic !== 'fLaC') throw new Error('not a FLAC stream');
    this.pos = 4;
    let last = false;
    while (!last) {
      const h = this.bytes[this.pos];
      last = (h & 0x80) !== 0;
      const type = h & 0x7f;
      this.pos++;
      const len = this._u24();
      const body = this.bytes.subarray(this.pos, this.pos + len);
      this.pos += len;
      this.metadata.push({ type, length: len, offset: this.pos - len });
      if (type === 0) this._parseStreamInfo(body);
      else if (type === 4) this._parseVorbis(body);
    }
    return this.streamInfo;
  }

  _parseStreamInfo(body) {
    const r = new BitReader(body);
    const minBlockSize = r.readBits(16);
    const maxBlockSize = r.readBits(16);
    const minFrameSize = r.readBits(24);
    const maxFrameSize = r.readBits(24);
    const sampleRate = r.readBits(20);
    const channels = r.readBits(3) + 1;
    const bits = r.readBits(5) + 1;
    const totalSamples = r.readBits(36);
    const md5 = new Uint8Array(16);
    for (let i = 0; i < 16; i++) md5[i] = r.readBits(8);
    this.streamInfo = {
      minBlockSize,
      maxBlockSize,
      minFrameSize,
      maxFrameSize,
      sampleRate,
      channels,
      bits,
      totalSamples,
      md5: [...md5].map((b) => b.toString(16).padStart(2, '0')).join(''),
    };
  }

  _parseVorbis(body) {
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let o = 0;
    const vendorLen = dv.getUint32(o, true);
    o += 4;
    const vendor = new TextDecoder().decode(body.subarray(o, o + vendorLen));
    o += vendorLen;
    this.vendor = vendor;
    const count = dv.getUint32(o, true);
    o += 4;
    for (let i = 0; i < count; i++) {
      const len = dv.getUint32(o, true);
      o += 4;
      this.vorbisComments.push(new TextDecoder().decode(body.subarray(o, o + len)));
      o += len;
    }
  }

  /** Decode all frames. Returns { audio:Int32Array, frames, samples }. */
  decodeAll({ verifyCRC = true } = {}) {
    if (!this.streamInfo) this.readMetadata();
    const si = this.streamInfo;
    const chs = si.channels;
    const frames = [];
    let total = 0;
    while (this.pos < this.bytes.length) {
      if (this.bytes.length - this.pos < 10) {
        // trailing padding is not legal FLAC; flag if non-zero
        let any = false;
        for (let i = this.pos; i < this.bytes.length; i++) if (this.bytes[i]) any = true;
        if (any) this.warnings.push('trailing garbage');
        break;
      }
      const frame = this._decodeFrame(verifyCRC);
      frame.offset = this.pos - frame.byteLength;
      frames.push(frame);
      total += frame.samples;
    }
    const audio = new Int32Array(total * chs);
    let o = 0;
    let expectedStart = 0;
    for (const f of frames) {
      if (f.frameNumber >= 0 && f.frameNumber !== expectedStart) {
        this.warnings.push(`frame number ${f.frameNumber} expected ${expectedStart}`);
      }
      expectedStart++;
      if (f.channels !== chs) this.warnings.push('channel count changed');
      for (let i = 0; i < f.samples * chs; i++) audio[o++] = f.samplesInt[i];
      f.samplesInt = null;
    }
    if (si.totalSamples !== 0 && si.totalSamples !== total) {
      this.warnings.push(`STREAMINFO samples ${si.totalSamples} != decoded ${total}`);
    }
    this.frames = frames.map((f) => ({
      frameNumber: f.frameNumber,
      samples: f.samples,
      offset: f.offset,
      byteLength: f.byteLength,
      blockSize: f.blockSize,
    }));
    this.decodedSamples = total;
    this.audio = audio;
    return { audio, samples: total, frames: this.frames };
  }

  _decodeFrame(verifyCRC) {
    const frameStart = this.pos;
    const r = new BitReader(this.bytes, this.pos);
    const sync = r.readBits(14);
    if (sync !== 0x3ffe) throw new Error(`bad frame sync at byte ${frameStart}`);
    r.readBit(); // reserved
    const variableBlock = r.readBit();
    const blockCode = r.readBits(4);
    const srCode = r.readBits(4);
    const assignment = r.readBits(4);
    const bpsCode = r.readBits(3);
    r.readBit(); // reserved
    const frameNumber = readUtf8(r);
    let blockSize;
    if (blockCode === 6) {
      blockSize = r.readBits(8) + 1;
    } else if (blockCode === 7) blockSize = r.readBits(16) + 1;
    else blockSize = BLOCK_CODE_SIZES.get(blockCode);
    if (blockSize === undefined) throw new Error('invalid block size code');
    if (srCode === 12) r.readBits(8);
    else if (srCode === 13 || srCode === 14) r.readBits(16);
    const headerEndByte = r.pos;
    const expectedCrc8 = r.readBits(8);
    const gotCrc8 = crc8(this.bytes, frameStart, headerEndByte);
    if (verifyCRC && expectedCrc8 !== gotCrc8) throw new Error(`frame header CRC-8 mismatch at ${frameStart}`);
    if (headerEndByte !== frameStart + (r.pos - frameStart - 1)) throw new Error('header not byte aligned');

    let channels;
    if (assignment < 8) channels = assignment + 1;
    else if (assignment <= 10) channels = 2;
    else throw new Error('reserved channel assignment');

    const firstBps = BPS_CODE_VALUES.get(bpsCode);
    if (firstBps === undefined) throw new Error('invalid bit depth code');

    const subframes = [];
    let bpsA = firstBps;
    let bpsB = firstBps;
    if (channels === 2 && assignment === 8) bpsB = firstBps + 1; // left/side
    if (channels === 2 && assignment === 9) bpsA = firstBps + 1; // side/right
    if (channels === 2 && assignment === 10) bpsB = firstBps + 1; // mid/side
    for (let c = 0; c < channels; c++) {
      subframes.push(this._readSubframe(r, blockSize, c === 0 ? bpsA : bpsB));
    }
    r.align();
    const bodyEnd = r.pos;
    const expectedCrc16 = r.readBits(16);
    const gotCrc16 = crc16(this.bytes, frameStart, bodyEnd);
    if (verifyCRC && expectedCrc16 !== gotCrc16) {
      throw new Error(`frame CRC-16 mismatch at ${frameStart}: ${gotCrc16.toString(16)} != ${expectedCrc16.toString(16)}`);
    }
    this.pos = r.pos;
    const byteLength = this.pos - frameStart;

    const out = new Int32Array(blockSize * channels);
    if (channels === 1) {
      out.set(subframes[0]);
    } else if (channels === 2 && assignment === 8) {
      // left/side
      for (let i = 0; i < blockSize; i++) {
        const l = subframes[0][i];
        const s = subframes[1][i];
        out[i * 2] = l;
        out[i * 2 + 1] = l - s;
      }
    } else if (channels === 2 && assignment === 9) {
      // side/right
      for (let i = 0; i < blockSize; i++) {
        const s = subframes[0][i];
        const rr = subframes[1][i];
        out[i * 2] = s + rr;
        out[i * 2 + 1] = rr;
      }
    } else if (channels === 2 && assignment === 10) {
      // mid = floor((L+R)/2), side = L-R. L+R and L-R share parity, so the
      // discarded LSB of the sum is side&1.
      for (let i = 0; i < blockSize; i++) {
        const side = subframes[1][i];
        const sum = 2 * subframes[0][i] + (side & 1);
        out[i * 2] = (sum + side) / 2;
        out[i * 2 + 1] = (sum - side) / 2;
      }
    } else if (channels === 2) {
      for (let i = 0; i < blockSize; i++) {
        out[i * 2] = subframes[0][i];
        out[i * 2 + 1] = subframes[1][i];
      }
    } else {
      for (let c = 0; c < channels; c++) {
        for (let i = 0; i < blockSize; i++) out[i * channels + c] = subframes[c][i];
      }
    }

    return {
      frameNumber,
      blockSize,
      samples: blockSize,
      channels,
      bits: firstBps,
      byteLength,
      samplesInt: out,
    };
  }

  _readSubframe(r, blockSize, bps) {
    const pad = r.readBit();
    if (pad !== 0) throw new Error('subframe padding bit set');
    const type = r.readBits(6);
    const wastedFlag = r.readBit();
    let wasted = 0;
    if (wastedFlag) wasted = r.readUnary() + 1;
    const ebps = bps - wasted;

    let data;
    if (type === 0) {
      const v = r.readSigned(ebps);
      data = new Int32Array(blockSize).fill(v);
    } else if (type === 1) {
      data = new Int32Array(blockSize);
      for (let i = 0; i < blockSize; i++) data[i] = r.readSigned(ebps);
    } else if (type >= 8 && type <= 12) {
      const order = type - 8;
      const warm = new Int32Array(order);
      for (let i = 0; i < order; i++) warm[i] = r.readSigned(ebps);
      const res = this._readResidual(r, blockSize, order);
      data = restoreFixed(warm, res, blockSize, order);
    } else if (type >= 32) {
      const order = type - 31;
      const warm = new Int32Array(order);
      for (let i = 0; i < order; i++) warm[i] = r.readSigned(ebps);
      const precision = r.readBits(4) + 1;
      if (precision === 16) throw new Error('reserved LPC precision');
      const shift = r.readSigned(5);
      if (shift < 0) throw new Error('negative LPC shift');
      const coeffs = new Float64Array(order + 1);
      coeffs[0] = 1;
      for (let i = 1; i <= order; i++) coeffs[i] = r.readSigned(precision);
      const res = this._readResidual(r, blockSize, order);
      data = restoreLpc(warm, res, blockSize, order, coeffs, shift);
    } else {
      throw new Error(`reserved subframe type ${type}`);
    }

    if (wasted) {
      const mul = Math.pow(2, wasted);
      const shifted = new Int32Array(blockSize);
      for (let i = 0; i < blockSize; i++) shifted[i] = data[i] * mul;
      data = shifted;
    }
    return data;
  }

  _readResidual(r, blockSize, order) {
    const method = r.readBits(2);
    if (method > 1) throw new Error('reserved residual coding method');
    const porder = r.readBits(4);
    const partitions = 1 << porder;
    if (blockSize % partitions !== 0) throw new Error('partition size not divisible');
    const base = blockSize / partitions;
    if (base <= order) throw new Error('partition smaller than predictor order');
    const res = new Float64Array(blockSize - order);
    let o = 0;
    for (let p = 0; p < partitions; p++) {
      const size = base - (p === 0 ? order : 0);
      const paramBits = method === 0 ? 4 : 5;
      const k = r.readBits(paramBits);
      const escape = method === 0 ? k === 15 : k === 31;
      if (escape) {
        const rawBits = r.readBits(5);
        if (rawBits === 0) {
          for (let i = 0; i < size; i++) res[o++] = 0;
        } else {
          for (let i = 0; i < size; i++) res[o++] = r.readSigned(rawBits);
        }
      } else if (k === 0) {
        for (let i = 0; i < size; i++) {
          const u = r.readUnary();
          // Zig-zag decode without 32-bit bitwise ops: u can exceed 2^32.
          res[o++] = u % 2 === 1 ? -(u + 1) / 2 : u / 2;
        }
      } else {
        const powK = Math.pow(2, k);
        for (let i = 0; i < size; i++) {
          const q = r.readUnary();
          const rem = r.readBits(k);
          const u = q * powK + rem;
          res[o++] = u % 2 === 1 ? -(u + 1) / 2 : u / 2;
        }
      }
    }
    return res;
  }
}

function restoreFixed(warm, res, n, order) {
  const out = new Int32Array(n);
  for (let i = 0; i < order; i++) out[i] = warm[i];
  for (let i = order; i < n; i++) {
    if (order === 0) out[i] = res[i];
    else if (order === 1) out[i] = out[i - 1] + res[i - order];
    else if (order === 2) out[i] = 2 * out[i - 1] - out[i - 2] + res[i - order];
    else if (order === 3) out[i] = 3 * out[i - 1] - 3 * out[i - 2] + out[i - 3] + res[i - order];
    else out[i] = 4 * out[i - 1] - 6 * out[i - 2] + 4 * out[i - 3] - out[i - 4] + res[i - order];
  }
  return out;
}

function restoreLpc(warm, res, n, order, coeffs, shift) {
  const out = new Int32Array(n);
  for (let i = 0; i < order; i++) out[i] = warm[i];
  const mul = Math.pow(2, shift);
  for (let i = order; i < n; i++) {
    let sum = 0;
    for (let j = 1; j <= order; j++) sum += coeffs[j] * out[i - j];
    out[i] = res[i - order] + Math.floor(sum / mul);
  }
  return out;
}

/** Convenience: decode a whole FLAC buffer and verify CRCs / MD5. */
export function decodeFlac(bytes, { verifyCRC = true, verifyMD5 = true } = {}) {
  const dec = new FlacDecoder(bytes);
  dec.readMetadata();
  const { audio, samples } = dec.decodeAll({ verifyCRC });
  const si = dec.streamInfo;
  let md5Ok = null;
  if (verifyMD5 && si.md5 !== '00000000000000000000000000000000') {
    const width = si.bits <= 8 ? 1 : si.bits <= 16 ? 2 : si.bits <= 24 ? 3 : 4;
    const md5 = new MD5();
    const buf = new Uint8Array(width * si.channels);
    let o = 0;
    for (let i = 0; i < samples * si.channels; i++) {
      const v = audio[i];
      if (width === 1) buf[o++] = v & 0xff;
      else {
        buf[o++] = v & 0xff;
        buf[o++] = (v >> 8) & 0xff;
        if (width >= 3) buf[o++] = (v >> 16) & 0xff;
        if (width === 4) buf[o++] = (v >> 24) & 0xff;
      }
      if (o === buf.length) {
        md5.update(buf);
        o = 0;
      }
    }
    const got = md5.hex();
    md5Ok = got === si.md5;
    if (!md5Ok) throw new Error(`FLAC MD5 mismatch: ${got} != ${si.md5}`);
  }
  return { audio, samples, streamInfo: si, frames: dec.frames, comments: dec.vorbisComments, warnings: dec.warnings, md5Ok, decoder: dec };
}
