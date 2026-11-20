// File-descriptor sink with the same interface as Uint8Sink, so the conversion
// core can write straight to disk without holding the output in memory.

import fs from 'node:fs';

export class FileSink {
  constructor(fd) {
    this.fd = fd;
    this.length = 0;
    this.isFile = true;
  }

  write(bytes) {
    let off = 0;
    while (off < bytes.length) {
      off += fs.writeSync(this.fd, bytes, off, bytes.length - off, this.length + off);
    }
    this.length += bytes.length;
  }

  patch(offset, bytes) {
    let off = 0;
    while (off < bytes.length) {
      off += fs.writeSync(this.fd, bytes, off, bytes.length - off, offset + off);
    }
  }

  read(offset, length) {
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const n = fs.readSync(this.fd, buf, got, length - got, offset + got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  }

  result() {
    return null;
  }
}
