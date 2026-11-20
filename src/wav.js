// WAV / RF64 reader and writer.
//
// Reader accepts PCM 8/16/24/32-bit (unsigned 8-bit, little-endian), IEEE
// float 32/64-bit, WAVE_FORMAT_EXTENSIBLE, and RF64 sizes. Input samples are
// normalised to float64 in [-1, 1) for integer formats and left untouched for
// float formats, matching the "true value" semantics the quantiser expects.
//
// Writer emits canonical PCM or IEEE-float WAV, automatically switching to
// RF64 when the payload would overflow the 32-bit RIFF size. The writer is
// streaming: header fields are patched by the caller via `headerPatch`.

const PCM_GUID_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

function fourcc(bytes, o) {
  return String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
}

export function parseWavHeader(bytes) {
  if (bytes.length < 12) throw new Error('WAV: file shorter than RIFF header');
  const magic = fourcc(bytes, 0);
  if (magic !== 'RIFF' && magic !== 'RF64') throw new Error('WAV: missing RIFF/RF64 signature');
  const isRF64 = magic === 'RF64';
  const riffSize = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true);
  const wave = fourcc(bytes, 8);
  if (wave !== 'WAVE') throw new Error('WAV: not a WAVE file');

  let fmt = null;
  let dataOffset = -1;
  let dataSize = -1;
  let ds64DataSize = -1;
  let ds64RiffSize = -1;
  let ds64Frames = -1;
  let pos = 12;
  const chunks = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (pos + 8 <= bytes.length) {
    const id = fourcc(bytes, pos);
    let size = dv.getUint32(pos + 4, true);
    chunks.push({ id, size, offset: pos });
    if (id === 'ds64' && size >= 28) {
      // Sizes precede the data chunk in every RF64 we emit.
      ds64RiffSize = dv.getUint32(pos + 8, true) + dv.getUint32(pos + 12, true) * 4294967296;
      ds64DataSize = dv.getUint32(pos + 16, true) + dv.getUint32(pos + 20, true) * 4294967296;
      ds64Frames = dv.getUint32(pos + 24, true) + dv.getUint32(pos + 28, true) * 4294967296;
    }
    if (id === 'fmt ') {
      if (size < 16) throw new Error('WAV: fmt chunk too small');
      fmt = {
        formatTag: dv.getUint16(pos + 8, true),
        channels: dv.getUint16(pos + 10, true),
        sampleRate: dv.getUint32(pos + 12, true),
        byteRate: dv.getUint32(pos + 16, true),
        blockAlign: dv.getUint16(pos + 20, true),
        bitsPerSample: dv.getUint16(pos + 22, true),
      };
      if (size >= 40) {
        fmt.cbSize = dv.getUint16(pos + 24, true);
        fmt.validBits = dv.getUint16(pos + 26, true);
        fmt.channelMask = dv.getUint32(pos + 28, true);
        let guidOk = true;
        for (let i = 0; i < 14; i++) if (bytes[pos + 34 + i] !== PCM_GUID_TAIL[i]) guidOk = false;
        const sub = dv.getUint16(pos + 32, true);
        if (guidOk) {
          fmt.subFormat = sub === 1 ? 'PCM' : sub === 3 ? 'FLOAT' : `TAG_${sub}`;
        } else fmt.subFormat = 'UNKNOWN';
      } else {
        fmt.validBits = fmt.bitsPerSample;
        fmt.subFormat = fmt.formatTag === 1 ? 'PCM' : fmt.formatTag === 3 ? 'FLOAT' : `TAG_${fmt.formatTag}`;
      }
    } else if (id === 'ds64') {
      if (size < 16) throw new Error('WAV: ds64 too small');
      // 64-bit sample counts / sizes, little-endian (low word first).
      ds64RiffSize = dv.getUint32(pos + 8, true) + dv.getUint32(pos + 12, true) * 4294967296;
      ds64DataSize = dv.getUint32(pos + 16, true) + dv.getUint32(pos + 20, true) * 4294967296;
    } else if (id === 'data') {
      dataOffset = pos + 8;
      dataSize = size;
      if (isRF64 && ds64DataSize >= 0) dataSize = ds64DataSize;
      break; // audio follows; ignore anything after
    }
    // A 0xffffffff size in RF64 is a placeholder resolved through ds64.
    if (isRF64 && size === 0xffffffff) break;
    pos += 8 + size + (size & 1);
  }
  if (!fmt) throw new Error('WAV: no fmt chunk');
  if (dataOffset < 0) throw new Error('WAV: no data chunk');
  if (dataSize < 0) throw new Error('WAV: data size unknown');

  let kind;
  if (fmt.formatTag === 1 || (fmt.formatTag === 0xfffe && fmt.subFormat === 'PCM')) kind = 'pcm';
  else if (fmt.formatTag === 3 || (fmt.formatTag === 0xfffe && fmt.subFormat === 'FLOAT')) kind = 'float';
  else throw new Error(`WAV: unsupported format tag ${fmt.formatTag}`);

  const bytesPerSample = fmt.blockAlign / fmt.channels;
  const totalFrames = Math.floor(dataSize / fmt.blockAlign);
  const available = Math.floor((bytes.length - dataOffset) / fmt.blockAlign);
  if (available < totalFrames) {
    // Truncated capture: still decode what is present, report the shortfall.
    fmt.truncated = true;
  }
  return {
    container: isRF64 ? 'RF64' : 'RIFF',
    kind,
    ...fmt,
    bytesPerSample,
    dataOffset,
    dataSize,
    totalFrames: Math.min(totalFrames, available),
    declaredFrames: totalFrames,
    rf64Declared: isRF64,
    riffSize,
    ds64RiffSize,
    ds64Frames,
    chunks,
  };
}

export function decodeWavSamples(header, bytes, maxFrames, startFrame = 0, channels = header.channels) {
  const { kind, bitsPerSample, validBits, dataOffset, blockAlign, totalFrames } = header;
  const frames = Math.min(maxFrames, totalFrames - startFrame);
  const out = new Float64Array(frames * channels);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fullCh = header.channels;
  const bytesPerSample = blockAlign / fullCh;
  const base = dataOffset + startFrame * blockAlign;

  if (kind === 'float') {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        const o = base + i * blockAlign + c * bytesPerSample;
        out[i * channels + c] = a2f(dv, o, bitsPerSample);
      }
    }
    return out;
  }

  // Integer PCM: normalise by the container width. validBits is metadata
  // adjacent to the quantiser's target and is reported separately.
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const o = base + i * blockAlign + c * bytesPerSample;
      let v;
      if (bitsPerSample === 8) v = (dv.getUint8(o) - 128) / 128;
      else if (bitsPerSample === 16) v = dv.getInt16(o, true) / 32768;
      else if (bitsPerSample === 24) {
        v = (dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16)) / 8388608;
      } else if (bitsPerSample === 32) v = dv.getInt32(o, true) / 2147483648;
      else throw new Error(`WAV: unsupported integer depth ${bitsPerSample}`);
      out[i * channels + c] = v;
    }
  }
  return out;
}

function a2f(dv, o, bits) {
  if (bits === 32) return dv.getFloat32(o, true);
  if (bits === 64) return dv.getFloat64(o, true);
  throw new Error(`WAV: unsupported float depth ${bits}`);
}

/** True integer code for a sample index, for direct comparisons in tests. */
export function readWavIntegerCode(header, bytes, frame, channel) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const o = header.dataOffset + frame * header.blockAlign + channel * header.bytesPerSample;
  switch (header.bitsPerSample) {
    case 8: return dv.getUint8(o) - 128;
    case 16: return dv.getInt16(o, true);
    case 24: return dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16);
    case 32: return dv.getInt32(o, true);
    default: throw new Error('not integral');
  }
}

/**
 * Build the WAV header. Returns { bytes, dataOffset, patchPositions }.
 * `frames` may be null when the length is unknown up front (streaming); the
 * caller then has to patch sizes with patchWavSizes().
 */
export function buildWavHeader({ sampleRate, channels, bits, kind = 'pcm', frames = 0, forceRF64 = false }) {
  if (kind !== 'pcm' && kind !== 'float') throw new Error(`WAV: bad kind ${kind}`);
  const bytesPerSample = bits / 8;
  const blockAlign = bytesPerSample * channels;
  const dataSize = frames * blockAlign;
  const useRF64 = forceRF64 || dataSize + 64 > 0xffffffff;
  const needExtensible = channels > 2 || bits > 16;

  const fmtChunk = needExtensible ? 40 : 16;
  const ds64Chunk = useRF64 ? 8 + 28 : 0;
  const dataOffset = 12 + ds64Chunk + 8 + fmtChunk + 8;
  const total = dataOffset + dataSize;

  // Only the header is returned; the caller appends the payload. `total`
  // (header + payload) is what the size fields must eventually describe.
  const out = new Uint8Array(dataOffset);
  const dv = new DataView(out.buffer);
  const put = (o, s) => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  put(0, useRF64 ? 'RF64' : 'RIFF');
  dv.setUint32(4, useRF64 ? 0xffffffff : Math.min(0xffffffff, total - 8), true);
  put(8, 'WAVE');

  let p = 12;
  let ds64Base = -1;
  if (useRF64) {
    ds64Base = p;
    put(p, 'ds64');
    dv.setUint32(p + 4, 28, true);
    // Little-endian 64-bit fields, low word first.
    dv.setUint32(p + 8, (total - 8) % 4294967296, true);
    dv.setUint32(p + 12, Math.floor((total - 8) / 4294967296), true);
    dv.setUint32(p + 16, dataSize % 4294967296, true);
    dv.setUint32(p + 20, Math.floor(dataSize / 4294967296), true);
    dv.setUint32(p + 24, frames % 4294967296, true);
    dv.setUint32(p + 28, Math.floor(frames / 4294967296), true);
    p += ds64Chunk;
  }

  put(p, 'fmt ');
  dv.setUint32(p + 4, fmtChunk, true);
  dv.setUint16(p + 8, needExtensible ? 0xfffe : kind === 'float' ? 3 : 1, true);
  dv.setUint16(p + 10, channels, true);
  dv.setUint32(p + 12, sampleRate, true);
  dv.setUint32(p + 16, sampleRate * blockAlign, true);
  dv.setUint16(p + 20, blockAlign, true);
  dv.setUint16(p + 22, bits, true);
  if (needExtensible) {
    dv.setUint16(p + 24, 22, true);
    dv.setUint16(p + 26, bits, true);
    dv.setUint32(p + 28, channelMask(channels), true);
    dv.setUint16(p + 32, kind === 'float' ? 3 : 1, true);
    for (let i = 0; i < 14; i++) out[p + 34 + i] = PCM_GUID_TAIL[i];
  }
  p += 8 + fmtChunk;

  const ds64SampleCountBase = ds64Base >= 0 ? ds64Base + 24 : -1;
  put(p, 'data');
  dv.setUint32(p + 4, useRF64 ? 0xffffffff : dataSize, true);
  const dataSizePatch = p + 4;

  return {
    bytes: out,
    dataOffset,
    rf64: useRF64,
    patches: {
      riffSize: 4,
      dataSize: dataSizePatch,
      ds64Riff: ds64Base >= 0 ? ds64Base + 8 : -1,
      ds64Data: ds64Base >= 0 ? ds64Base + 16 : -1,
      ds64Frames: ds64SampleCountBase,
    },
    bytesPerSample,
    blockAlign,
  };
}

export function patchWavSizes(bytes, patches, { dataSize, frames }) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // patches.dataSize points at the 4-byte size field; audio starts after it.
  // `total` must equal payload offset + data size, so use the header bytes the
  // caller actually wrote (all emitted headers are byte-aligned: 80 or 44).
  const headerBytes = patches.dataSize + 4;
  const total = headerBytes + dataSize;
  if (patches.ds64Data >= 0) {
    dv.setUint32(4, 0xffffffff, true);
    dv.setUint32(patches.ds64Riff, (total - 8) % 4294967296, true);
    dv.setUint32(patches.ds64Riff + 4, Math.floor((total - 8) / 4294967296), true);
    dv.setUint32(patches.ds64Data, dataSize % 4294967296, true);
    dv.setUint32(patches.ds64Data + 4, Math.floor(dataSize / 4294967296), true);
    dv.setUint32(patches.ds64Frames, frames % 4294967296, true);
    dv.setUint32(patches.ds64Frames + 4, Math.floor(frames / 4294967296), true);
    dv.setUint32(patches.dataSize, 0xffffffff, true);
  } else {
    dv.setUint32(patches.riffSize, total - 8, true);
    dv.setUint32(patches.dataSize, dataSize, true);
  }
  return bytes;
}

export function channelMask(channels) {
  if (channels === 1) return 0x4; // FC
  if (channels === 2) return 0x3; // FL FR
  return 0; // unspecified for exotic layouts
}

/** Encode interleaved integers into WAV data bytes for the given depth. */
export function encodeWavIntegers(samples, bits, out = null, outOffset = 0) {
  const width = bits / 8;
  const need = outOffset + samples.length * width;
  if (!out) out = new Uint8Array(need);
  else if (out.length < need) throw new RangeError('WAV: output buffer too small');
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (bits === 8) {
    for (let i = 0; i < samples.length; i++) dv.setUint8(outOffset + i, (samples[i] + 128) & 0xff);
  } else if (bits === 16) {
    for (let i = 0; i < samples.length; i++) dv.setInt16(outOffset + i * 2, samples[i], true);
  } else if (bits === 24) {
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      const o = outOffset + i * 3;
      dv.setUint8(o, v & 0xff);
      dv.setUint8(o + 1, (v >> 8) & 0xff);
      dv.setUint8(o + 2, (v >> 16) & 0xff);
    }
  } else if (bits === 32) {
    for (let i = 0; i < samples.length; i++) dv.setInt32(outOffset + i * 4, samples[i], true);
  } else throw new Error(`WAV: unsupported write depth ${bits}`);
  return { bytes: out.subarray(0, need), nextOffset: need };
}

/** Encode float samples, converting nothing (32-bit float keeps exactness of
 *  values representable in float32, 64-bit float keeps float64 exactly). */
export function encodeWavFloats(samples, bits, out = null, outOffset = 0) {
  const width = bits / 8;
  const need = outOffset + samples.length * width;
  if (!out) out = new Uint8Array(need);
  else if (out.length < need) throw new RangeError('WAV: output buffer too small');
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (bits === 32) {
    for (let i = 0; i < samples.length; i++) dv.setFloat32(outOffset + i * 4, samples[i], true);
  } else if (bits === 64) {
    for (let i = 0; i < samples.length; i++) dv.setFloat64(outOffset + i * 8, samples[i], true);
  } else throw new Error(`WAV: unsupported float write depth ${bits}`);
  return { bytes: out.subarray(0, need), nextOffset: need };
}
