// MSB-first bit writer/reader used by the FLAC codec. Values are JS numbers
// exact up to 2^53, so 32-bit audio, 33-bit side channels and Rice quotients
// all work. Writes of n > 53 are rejected.

export class BitWriter {
  constructor(initialBytes = 1 << 16) {
    this.buf = new Uint8Array(initialBytes);
    this.pos = 0;
    this.cur = 0;
    this.used = 0;
  }

  _ensure(n) {
    const need = this.pos + n;
    if (need <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  writeBit(b) {
    this.cur = (this.cur << 1) | (b & 1);
    this.used++;
    if (this.used === 8) {
      this._ensure(1);
      this.buf[this.pos++] = this.cur;
      this.cur = 0;
      this.used = 0;
    }
  }

  writeBits(value, n) {
    if (n <= 0) return;
    if (n > 53) throw new RangeError('bitio: n>53');
    let v = value;
    if (v < 0) v += Math.pow(2, n);
    if (!Number.isFinite(v) || v < 0 || v >= Math.pow(2, n)) {
      throw new RangeError(`bitio: ${value} does not fit ${n} bits`);
    }
    const high = Math.floor(v / 4294967296);
    const low = v % 4294967296;
    if (n > 32) {
      this.writeBits(high, n - 32);
      this.writeBits(low, 32);
      return;
    }
    for (let shift = n - 1; shift >= 0; shift--) {
      const bit = Math.floor(v / Math.pow(2, shift)) % 2;
      this.writeBit(bit);
    }
  }

  writeSigned(value, n) {
    this.writeBits(value < 0 ? value + Math.pow(2, n) : value, n);
  }

  writeZeros(n) {
    while (n >= 8 && this.used === 0) {
      const bytes = Math.min(n >> 3, 1 << 20);
      this._ensure(bytes);
      this.buf.fill(0, this.pos, this.pos + bytes);
      this.pos += bytes;
      n -= bytes * 8;
    }
    while (n-- > 0) this.writeBit(0);
  }

  writeUnary(q) {
    if (!(q >= 0) || !Number.isFinite(q)) throw new RangeError('bitio: bad unary');
    this.writeZeros(q);
    this.writeBit(1);
  }

  alignZero() {
    if (this.used !== 0) this.writeBits(0, 8 - this.used);
  }

  bytes() {
    this.alignZero();
    return this.buf.subarray(0, this.pos);
  }

  get bitLength() {
    return this.pos * 8 + this.used;
  }
}

export class BitReader {
  constructor(bytes, byteOffset = 0) {
    this.buf = bytes;
    this.pos = byteOffset;
    this.cur = 0;
    this.used = 0;
  }

  readBit() {
    if (this.used === 0) {
      if (this.pos >= this.buf.length) throw new RangeError('bitio: eof');
      this.cur = this.buf[this.pos++];
      this.used = 8;
    }
    this.used--;
    return (this.cur >> this.used) & 1;
  }

  readBits(n) {
    if (n <= 0) return 0;
    if (n > 53) throw new RangeError('bitio: n>53');
    if (n > 32) {
      const highBits = n - 32;
      const high = this.readBits(highBits);
      const low = this.readBits(32);
      return high * 4294967296 + low;
    }
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.readBit();
    return v;
  }

  readSigned(n) {
    const v = this.readBits(n);
    const half = Math.pow(2, n - 1);
    return v >= half ? v - Math.pow(2, n) : v;
  }

  readUnary(limit = 1 << 26) {
    let q = 0;
    while (this.readBit() === 0) {
      if (++q > limit) throw new RangeError('bitio: unary limit');
    }
    return q;
  }

  align() {
    this.used = 0;
  }

  get bitPosition() {
    return this.pos * 8 - this.used;
  }
}
