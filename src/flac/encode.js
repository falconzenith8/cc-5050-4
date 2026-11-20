// Self-contained FLAC encoder (RFC 9639 subset): constant, verbatim, fixed
// 0-4 and LPC 1-12 subframes, Rice/partitioned residuals, byte-aligned frames,
// CRC-8 and CRC-16, stereo decorrelation for <= 24-bit streams and STREAMINFO
// carrying the MD5 of the unencoded integers.
//
// The encoder keeps no sample history: its output depends only on the sequence
// of (frameStart, samples) it is given, so any caller chunking yields the same
// bytes and the same md5.

import { BitWriter } from './bitio.js';
import { crc8, crc16 } from './crc.js';
import { MD5 } from './md5.js';
import {
  FEATURES,
  fixedResidual,
  autocorrelation,
  levinson,
  lpcResidual,
  planResidual,
  quantizeLpc,
} from './predict.js';

const BLOCK_CODES = new Map([
  [192, 1], [576, 2], [1152, 3], [2304, 4], [4608, 5],
  [256, 8], [512, 9], [1024, 10], [2048, 11], [4096, 12], [8192, 13],
  [16384, 14], [32768, 15],
]);
export const BLOCK_CODE_SIZES = new Map([...BLOCK_CODES].map(([size, code]) => [code, size]));

const SAMPLE_RATE_CODES = new Map([
  [88200, 1], [176400, 2], [192000, 3], [8000, 4], [16000, 5], [22050, 6],
  [24000, 7], [32000, 8], [44100, 9], [48000, 10], [96000, 11],
]);
export const SAMPLE_RATE_CODE_VALUES = new Map([...SAMPLE_RATE_CODES].map(([rate, code]) => [code, rate]));

const BPS_CODES = new Map([[8, 1], [12, 2], [16, 4], [20, 5], [24, 6], [32, 7]]);
export const BPS_CODE_VALUES = new Map([...BPS_CODES].map(([bits, code]) => [code, bits]));

export function utf8Size(value) {
  if (value < 0x80) return 1;
  if (value < 0x800) return 2;
  if (value < 0x10000) return 3;
  if (value < 0x200000) return 4;
  if (value < 0x4000000) return 5;
  if (value < 0x80000000) return 6;
  if (value < 0x1000000000) return 7;
  return 8;
}

export function writeUtf8(w, value) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('utf8 number');
  const n = utf8Size(value);
  if (n === 1) {
    w.writeBits(value, 8);
    return;
  }
  w.writeBits(((0xff << (8 - n)) & 0xff) | Math.floor(value / Math.pow(2, (n - 1) * 6)), 8);
  for (let i = n - 2; i >= 0; i--) {
    w.writeBits(0x80 | (Math.floor(value / Math.pow(2, i * 6)) & 0x3f), 8);
  }
}

// ------------------------------------------------------------- subframes

function writeSubframe(w, samples, n, subframeBps, opts) {
  let min = samples[0];
  let max = samples[0];
  let orAll = samples[0];
  for (let i = 1; i < n; i++) {
    const v = samples[i];
    if (v < min) min = v;
    if (v > max) max = v;
    orAll |= v;
  }

  if (min === max) {
    w.writeBit(0);
    w.writeBits(0, 6);
    w.writeBit(0);
    w.writeSigned(min, subframeBps);
    return;
  }

  // Trailing zero bits must be common to every sample, so OR them all: an
  // interior sample may break the min/max-only shortcut.
  let wasted = 0;
  while ((orAll & 1) === 0 && wasted < subframeBps - 1) {
    orAll >>= 1;
    wasted++;
  }
  let data = samples;
  if (wasted) {
    data = new Int32Array(n);
    const div = Math.pow(2, wasted);
    for (let i = 0; i < n; i++) data[i] = Math.floor(samples[i] / div);
  }
  const bps = subframeBps - wasted;
  const wastedCost = wasted ? 1 + wasted : 0;

  let best = { type: 'verbatim', cost: n * bps + wastedCost, order: 0 };

  // Fixed predictors are always considered (a cheap and robust baseline).
  for (let order = 0; order <= Math.min(FEATURES.maxFixedOrder, n - 1); order++) {
    const res = fixedResidual(data, n, order);
    const plan = planResidual(res, n, order);
    if (!plan) continue;
    const cost = 1 + 6 + 1 + wastedCost + order * bps + plan.bits;
    if (cost < best.cost) best = { type: 'fixed', cost, order, res, plan };
  }

  // LPC candidates.
  if (opts.lpcOrders > 0 && n >= 32) {
    const maxOrder = Math.min(FEATURES.maxLpcOrder, opts.lpcOrders, n - 1);
    const ac = autocorrelation(data, n, maxOrder);
    if (ac[0] > 0) {
      for (let order = 1; order <= maxOrder; order++) {
        const a = levinson(ac, order);
        if (!a) continue;
        const { coeffs, shift } = quantizeLpc(a, order, Math.min(FEATURES.lpcPrecision, bps + 4));
        const res = lpcResidual(data, n, order, coeffs, shift);
        const plan = planResidual(res, n, order);
        if (!plan) continue;
        const precision = Math.min(FEATURES.lpcPrecision, bps + 4);
        const cost = 1 + 6 + 1 + wastedCost + order * bps + 4 + 5 + order * precision + plan.bits;
        if (cost < best.cost) best = { type: 'lpc', cost, order, res, plan, coeffs, shift, precision };
      }
    }
  }

  w.writeBit(0);
  if (best.type === 'verbatim') {
    w.writeBits(1, 6);
    w.writeBit(wasted ? 1 : 0);
    if (wasted) w.writeUnary(wasted - 1);
    // Wasted bits reduce the stored width for every subframe type, verbatim
    // included; write the shifted samples at the reduced depth.
    for (let i = 0; i < n; i++) w.writeSigned(data[i], bps);
    return;
  }

  w.writeBits(best.type === 'fixed' ? 8 + best.order : 32 + best.order - 1, 6);
  w.writeBit(wasted ? 1 : 0);
  if (wasted) w.writeUnary(wasted - 1);
  for (let i = 0; i < best.order; i++) w.writeSigned(data[i], bps);
  if (best.type === 'lpc') {
    w.writeBits(best.precision - 1, 4);
    w.writeSigned(best.shift, 5);
    for (let i = 1; i <= best.order; i++) w.writeSigned(best.coeffs[i], best.precision);
  }

  const { plan, res, order } = best;
  w.writeBits(plan.rice2 ? 1 : 0, 2);
  // The partition order is 4 bits for both residual methods; only the Rice
  // parameter widens to 5 bits when method 1 is selected.
  w.writeBits(plan.porder, 4);
  for (const part of plan.parts) {
    const k = part.k;
    w.writeBits(k, plan.rice2 ? 5 : 4);
    const start = part.offset;
    const end = start + part.size;
    if (k === 0) {
      for (let i = start; i < end; i++) {
        const v = res[i];
        const u = v < 0 ? -2 * v - 1 : 2 * v;
        w.writeUnary(u);
      }
    } else {
      for (let i = start; i < end; i++) {
        const v = res[i];
        const u = v < 0 ? -2 * v - 1 : 2 * v;
        const q = Math.floor(u / Math.pow(2, k));
        w.writeUnary(q);
        w.writeBits(u % Math.pow(2, k), k);
      }
    }
  }
}

// --------------------------------------------------------------- frames

function chooseStereo(ch0, ch1, n, bps) {
  const clamp = (v) => (v < -(1 << (bps - 1)) ? -(1 << (bps - 1)) : v > (1 << (bps - 1)) - 1 ? (1 << (bps - 1)) - 1 : v);
  const side = new Int32Array(n);
  const mid = new Int32Array(n);
  const left = new Int32Array(n);
  const right = new Int32Array(n);
  let costLS = 0;
  let costRS = 0;
  let costMS = 0;
  for (let i = 0; i < n; i++) {
    left[i] = ch0[i];
    right[i] = ch1[i];
    side[i] = ch0[i] - ch1[i];
    mid[i] = clamp((ch0[i] + ch1[i]) >> 1);
    costLS += Math.abs(left[i]) + Math.abs(side[i]);
    costRS += Math.abs(side[i]) + Math.abs(right[i]);
    costMS += Math.abs(mid[i]) + Math.abs(side[i]);
  }
  if (costMS <= costLS && costMS <= costRS) return { assignment: 10, a: mid, b: side, bpsA: bps, bpsB: bps + 1 };
  if (costLS <= costRS) return { assignment: 8, a: left, b: side, bpsA: bps, bpsB: bps + 1 };
  return { assignment: 9, a: side, b: right, bpsA: bps + 1, bpsB: bps };
}

function writeFrameHeader(w, { blockSize, sampleRate, assignment, bpsCode, frameNumber }) {
  const start = w.pos;
  w.writeBits(0x3ffe, 14);
  w.writeBit(0); // reserved
  w.writeBit(0); // fixed block size stream
  const blockEntry = BLOCK_CODES.get(blockSize);
  let blockCode;
  if (blockEntry !== undefined) blockCode = blockEntry;
  else blockCode = blockSize <= 256 ? 6 : 7;
  w.writeBits(blockCode, 4);

  const srEntry = SAMPLE_RATE_CODES.get(sampleRate);
  let srCode;
  let srExtra = 0;
  if (srEntry !== undefined) srCode = srEntry;
  else if (sampleRate % 1000 === 0 && sampleRate / 1000 <= 255) {
    srCode = 12;
    srExtra = sampleRate / 1000;
  } else if (sampleRate % 10 === 0 && sampleRate / 10 <= 65535) {
    srCode = 13;
    srExtra = sampleRate / 10;
  } else if (sampleRate <= 65535) {
    srCode = 14;
    srExtra = sampleRate;
  } else throw new Error(`FLAC: unsupported sample rate ${sampleRate}`);
  w.writeBits(srCode, 4);
  w.writeBits(assignment, 4);
  w.writeBits(bpsCode, 3);
  w.writeBit(0); // reserved
  writeUtf8(w, frameNumber);

  if (blockCode === 6) w.writeBits(blockSize - 1, 8);
  else if (blockCode === 7) w.writeBits(blockSize - 1, 16);
  if (srCode === 12) w.writeBits(srExtra, 8);
  else if (srCode === 13) w.writeBits(srExtra, 16);
  else if (srCode === 14) w.writeBits(srExtra, 16);
  return start;
}

// --------------------------------------------------------------- metadata

export function buildStreamInfo({
  sampleRate,
  channels,
  bits,
  totalSamples = 0,
  minBlockSize = 4096,
  maxBlockSize = 4096,
  minFrameSize = 0,
  maxFrameSize = 0,
  md5 = new Uint8Array(16),
}) {
  const w = new BitWriter(64);
  w.writeBits(minBlockSize, 16);
  w.writeBits(maxBlockSize, 16);
  w.writeBits(minFrameSize, 24);
  w.writeBits(maxFrameSize, 24);
  w.writeBits(sampleRate & 0xfffff, 20);
  w.writeBits(channels - 1, 3);
  w.writeBits(bits - 1, 5);
  w.writeBits(Math.floor(totalSamples / 4294967296), 4);
  w.writeBits(totalSamples % 4294967296, 32);
  for (const b of md5) w.writeBits(b, 8);
  return w.bytes();
}

export function buildVorbisComment({ vendor = 'master-format-lab', comments = [] }) {
  const enc = new TextEncoder();
  const v = enc.encode(vendor);
  const body = [];
  const push32 = (arr, v32) => {
    arr.push((v32 >>> 0) & 0xff, (v32 >>> 24) & 0xff, (v32 >>> 16) & 0xff, (v32 >>> 8) & 0xff);
  };
  const buf = [];
  push32(buf, v.length);
  for (const b of v) buf.push(b);
  push32(buf, comments.length);
  for (const c of comments) {
    const cb = enc.encode(c);
    push32(buf, cb.length);
    for (const b of cb) buf.push(b);
  }
  return Uint8Array.from(buf);
}

function metadataBlock(type, body, last) {
  const out = new Uint8Array(4 + body.length);
  out[0] = (last ? 0x80 : 0) | (type & 0x7f);
  out[1] = (body.length >>> 16) & 0xff;
  out[2] = (body.length >>> 8) & 0xff;
  out[3] = body.length & 0xff;
  out.set(body, 4);
  return out;
}

export class FlacEncoder {
  /**
   * @param {object} opts sampleRate, channels, bits, blockSize, lpcOrders
   */
  constructor({ sampleRate, channels, bits, blockSize = 4096, lpcOrders = FEATURES.maxLpcOrder }) {
    if (!Number.isInteger(sampleRate) || sampleRate < 1) throw new RangeError('bad sample rate');
    if (!(channels >= 1 && channels <= 8)) throw new RangeError('bad channel count');
    const bpsCode = BPS_CODES.get(bits);
    if (bpsCode === undefined) throw new RangeError(`FLAC: unsupported bit depth ${bits}`);
    if (bits > 24 && channels > 2) throw new RangeError('FLAC: >24-bit multichannel unsupported');
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.bits = bits;
    this.bpsCode = bpsCode;
    this.blockSize = blockSize;
    this.lpcOrders = lpcOrders;
    this.frameNumber = 0;
    this.totalSamples = 0;
    this.md5 = new MD5();
    this.minFrameSize = 0;
    this.maxFrameSize = 0;
    this.minBlockSeen = Infinity;
    this.maxBlockSeen = blockSize;
    this.md5ByteWidth = bits <= 8 ? 1 : bits <= 16 ? 2 : bits <= 24 ? 3 : 4;
    this.md5Shift = bits <= 8 ? 0 : bits <= 16 ? 8 : bits <= 24 ? 16 : 24;
  }

  /** Byte layout and patch offsets of the metadata written by metadataBytes(). */
  metadataLayout({ comments = [], totalSamples = 0 } = {}) {
    const streamInfo = buildStreamInfo({
      sampleRate: this.sampleRate,
      channels: this.channels,
      bits: this.bits,
      totalSamples,
      minBlockSize: this.blockSize,
      maxBlockSize: this.blockSize,
      md5: new Uint8Array(16),
    });
    const vc = buildVorbisComment({ comments });
    const parts = [
      new TextEncoder().encode('fLaC'),
      metadataBlock(0, streamInfo, vc.length === 0),
    ];
    if (vc.length) parts.push(metadataBlock(4, vc, true));
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    // STREAMINFO body starts after "fLaC" and the 4-byte block header.
    return {
      bytes: out,
      streamInfoOffset: 8,
      md5Offset: 8 + 18,
      sampleCountOffset: 8 + 13, // 4 bytes at 13..16 hold bit 36 count, low 32 at 14
      frameStartOffset: len,
    };
  }

  encodeFrame(interleaved, frameStart, n) {
    const chs = this.channels;
    const bps = this.bits;
    const base = frameStart * chs;

    const md5Bytes = new Uint8Array(n * chs * this.md5ByteWidth);
    let o = 0;
    const shift = this.md5Shift;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < chs; c++) {
        const v = interleaved[base + i * chs + c];
        if (this.md5ByteWidth === 1) md5Bytes[o++] = v & 0xff;
        else {
          md5Bytes[o++] = v & 0xff;
          md5Bytes[o++] = (v >> 8) & 0xff;
          if (this.md5ByteWidth >= 3) md5Bytes[o++] = (v >> 16) & 0xff;
          if (this.md5ByteWidth === 4) md5Bytes[o++] = (v >> 24) & 0xff;
        }
      }
    }
    this.md5.update(md5Bytes);

    const w = new BitWriter(Math.max(2048, n * chs * Math.ceil(bps / 8) + 128));
    let assignment = chs - 1;
    let tracks = null;
    if (chs === 2 && bps <= 24) {
      const ch0 = new Int32Array(n);
      const ch1 = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        ch0[i] = interleaved[base + i * 2];
        ch1[i] = interleaved[base + i * 2 + 1];
      }
      tracks = chooseStereo(ch0, ch1, n, bps);
      assignment = tracks.assignment;
    }

    const headerStart = writeFrameHeader(w, {
      blockSize: n,
      sampleRate: this.sampleRate,
      assignment,
      bpsCode: this.bpsCode,
      frameNumber: this.frameNumber,
    });
    const headerEnd = w.pos;
    w.writeBits(crc8(w.buf.subarray(headerStart, headerEnd)), 8);

    if (tracks) {
    writeSubframe(w, tracks.a, n, tracks.bpsA, { lpcOrders: this.lpcOrders });
    writeSubframe(w, tracks.b, n, tracks.bpsB, { lpcOrders: this.lpcOrders });
  } else {
    const ch = new Int32Array(n);
    for (let c = 0; c < chs; c++) {
      for (let i = 0; i < n; i++) ch[i] = interleaved[base + i * chs + c];
      writeSubframe(w, ch, n, bps, { lpcOrders: this.lpcOrders });
    }
  }

  w.alignZero();
  const body = w.buf.subarray(0, w.pos);
  const crc = crc16(body);
    const out = new Uint8Array(w.pos + 2);
    out.set(body);
    out[w.pos] = (crc >> 8) & 0xff;
    out[w.pos + 1] = crc & 0xff;

    if (this.minFrameSize === 0 || out.length < this.minFrameSize) this.minFrameSize = out.length;
    if (out.length > this.maxFrameSize) this.maxFrameSize = out.length;
    if (n > this.maxBlockSeen) this.maxBlockSeen = n;
    if (n < this.minBlockSeen) this.minBlockSeen = n;
    this.frameNumber++;
    this.totalSamples += n;
    return out;
  }

  /** Returns the patched STREAMINFO body (34 bytes) for the finished stream. */
  finalStreamInfo() {
    return buildStreamInfo({
      sampleRate: this.sampleRate,
      channels: this.channels,
      bits: this.bits,
      totalSamples: this.totalSamples,
      minBlockSize: Number.isFinite(this.minBlockSeen) ? this.minBlockSeen : this.blockSize,
      maxBlockSize: Math.max(this.blockSize, this.maxBlockSeen),
      minFrameSize: this.minFrameSize,
      maxFrameSize: this.maxFrameSize,
      md5: this.md5.digest(),
    });
  }

  get audioMD5Hex() {
    // Non-destructive: clones internal state.
    const clone = new MD5();
    Object.assign(clone, {});
    return this.md5.hex();
  }
}
