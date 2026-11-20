// Incremental MD5 (RFC 1321), needed for the FLAC STREAMINFO audio signature.
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;

export class MD5 {
  constructor() {
    this.a = 0x67452301;
    this.b = 0xefcdab89;
    this.c = 0x98badcfe;
    this.d = 0x10325476;
    this.buffer = new Uint8Array(64);
    this.bufferLen = 0;
    this.bytes = 0n;
  }

  update(data) {
    if (typeof data === 'string') data = new TextEncoder().encode(data);
    this.bytes += BigInt(data.length);
    let i = 0;
    if (this.bufferLen > 0) {
      const need = 64 - this.bufferLen;
      const take = Math.min(need, data.length);
      this.buffer.set(data.subarray(0, take), this.bufferLen);
      this.bufferLen += take;
      i = take;
      if (this.bufferLen === 64) {
        this._block(this.buffer, 0);
        this.bufferLen = 0;
      }
    }
    for (; i + 64 <= data.length; i += 64) this._block(data, i);
    if (i < data.length) {
      this.buffer.set(data.subarray(i), 0);
      this.bufferLen = data.length - i;
    }
    return this;
  }

  _block(buf, off) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      M[i] = (buf[j] | (buf[j + 1] << 8) | (buf[j + 2] << 16) | (buf[j + 3] << 24)) >>> 0;
    }
    let a = this.a, b = this.b, c = this.c, d = this.d;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      const tmp = d;
      d = c;
      c = b;
      const sum = (a + f + K[i] + M[g]) >>> 0;
      const rot = S[i];
      b = (b + ((sum << rot) | (sum >>> (32 - rot)))) >>> 0;
      a = tmp;
    }
    this.a = (this.a + a) >>> 0;
    this.b = (this.b + b) >>> 0;
    this.c = (this.c + c) >>> 0;
    this.d = (this.d + d) >>> 0;
  }

  digest() {
    const clone = new MD5();
    clone.a = this.a;
    clone.b = this.b;
    clone.c = this.c;
    clone.d = this.d;
    clone.buffer.set(this.buffer);
    clone.bufferLen = this.bufferLen;
    clone.bytes = this.bytes;

    const bitLen = this.bytes * 8n;
    const padLen = (this.bufferLen < 56 ? 56 : 120) - this.bufferLen;
    const pad = new Uint8Array(padLen + 8);
    pad[0] = 0x80;
    const dv = new DataView(pad.buffer);
    dv.setBigUint64(padLen, bitLen, true);
    clone.update(pad);
    if (clone.bufferLen !== 0) throw new Error('md5 internal: unaligned final block');

    const out = new Uint8Array(16);
    const odv = new DataView(out.buffer);
    odv.setUint32(0, clone.a, true);
    odv.setUint32(4, clone.b, true);
    odv.setUint32(8, clone.c, true);
    odv.setUint32(12, clone.d, true);
    return out;
  }

  hex() {
    return [...this.digest()].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}

export function md5Hex(data) {
  return new MD5().update(data).hex();
}
