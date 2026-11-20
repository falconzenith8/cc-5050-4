// FLAC uses CRC-8 (poly 0x07) over the frame header and CRC-16 (poly 0x8005)
// over the whole frame. Both are non-reflected, init 0.

const T8 = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  T8[i] = c;
}

const T16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 8;
  for (let b = 0; b < 8; b++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
  T16[i] = c;
}

export function crc8(bytes, start = 0, end = bytes.length, initial = 0) {
  let c = initial & 0xff;
  for (let i = start; i < end; i++) c = T8[(c ^ bytes[i]) & 0xff];
  return c;
}

export function crc16(bytes, start = 0, end = bytes.length, initial = 0) {
  let c = initial & 0xffff;
  for (let i = start; i < end; i++) c = ((c << 8) & 0xffff) ^ T16[((c >>> 8) ^ bytes[i]) & 0xff];
  return c;
}

export function crc8Update(c, byte) {
  return T8[(c ^ byte) & 0xff];
}

export function crc16Update(c, byte) {
  return ((c << 8) & 0xffff) ^ T16[((c >>> 8) ^ byte) & 0xff];
}
