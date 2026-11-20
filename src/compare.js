// Independent decoding and pointwise comparison of produced containers.
//
// Used by the browser's differential playback and by `mfl diff`. Nothing here
// reads the conversion report for sample counts; both files are parsed and
// decoded from their bytes.

import { parseWavHeader, decodeWavSamples } from './wav.js';
import { decodeFlac } from './flac/decode.js';

/**
 * Decode a whole WAV/FLAC file to a normalised sample representation.
 * Integer containers come back as Int32 codes; float containers as Float64
 * values in [-1, 1] (so they can also be auditioned).
 */
export function decodeContainer(bytes, container) {
  if (container === 'flac') {
    const dec = decodeFlac(bytes);
    return {
      kind: 'pcm',
      data: dec.audio,
      channels: dec.streamInfo.channels,
      sampleRate: dec.streamInfo.sampleRate,
      bits: dec.streamInfo.bits,
      frames: dec.samples,
      md5Ok: dec.md5Ok,
      warnings: dec.warnings,
    };
  }
  const header = parseWavHeader(bytes);
  const frames = header.totalFrames;
  const samples = decodeWavSamples(header, bytes, frames);
  if (header.kind === 'float') {
    return { kind: 'float', data: samples, channels: header.channels, sampleRate: header.sampleRate, bits: header.bitsPerSample, frames };
  }
  const codes = new Int32Array(samples.length);
  const scale = Math.pow(2, header.bitsPerSample - 1);
  for (let i = 0; i < samples.length; i++) codes[i] = Math.round(samples[i] * scale);
  return { kind: 'pcm', data: codes, channels: header.channels, sampleRate: header.sampleRate, bits: header.bitsPerSample, frames };
}

/**
 * Pointwise difference between two decoded containers. Returns the difference
 * normalised to [-1, 1] (as float64) plus a summary. An exact match yields an
 * all-zero difference, which is the proof that both containers are lossless.
 */
export function compareDecoded(a, b) {
  const channels = Math.min(a.channels, b.channels);
  const frames = Math.min(a.frames, b.frames);
  const n = frames * channels;
  const scaleA = a.kind === 'pcm' ? Math.pow(2, a.bits - 1) : 1;
  const scaleB = b.kind === 'pcm' ? Math.pow(2, b.bits - 1) : 1;
  const diff = new Float64Array(n);
  let mismatches = 0;
  let first = -1;
  let maxAbsDiff = 0;
  const sameDepth = a.kind === b.kind && (a.kind === 'float' || a.bits === b.bits);
  for (let i = 0; i < n; i++) {
    const va = a.data[i] / scaleA;
    const vb = b.data[i] / scaleB;
    const d = va - vb;
    diff[i] = d;
    const abs = Math.abs(d);
    if (abs > maxAbsDiff) maxAbsDiff = abs;
    if (abs > 0) {
      mismatches++;
      if (first < 0) first = i;
    }
  }
  const lengthMatch = a.frames === b.frames && a.channels === b.channels;
  return {
    channels,
    frames,
    samplesCompared: n,
    lengthMatch,
    sameDepth,
    mismatches,
    maxAbsDiff,
    firstMismatch: first < 0 ? null : { frame: Math.floor(first / channels), channel: first % channels },
    identical: mismatches === 0 && lengthMatch && sameDepth,
    diff,
    detail: mismatches === 0 && lengthMatch
      ? `${n} samples; difference is digital silence`
      : `${mismatches} differing samples, max |diff| ${maxAbsDiff.toExponential(3)}${lengthMatch ? '' : ' (length mismatch)'}`,
  };
}
