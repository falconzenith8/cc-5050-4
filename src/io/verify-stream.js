// Streaming verification for files too large to hold in memory twice.
//
// Reads the produced file back through a decoder one block at a time and
// compares it to codes regenerated from the source. Nothing here trusts the
// conversion report for length or values.

import { FileSource } from './file-source.js';
import { IntegerQuantizer } from '../core/quantize.js';

/** Iterate integer codes from a WAV file without loading it whole. */
export function* wavCodeBlocks(fileSource, blockFrames) {
  const { channels, header } = fileSource;
  const bits = header.bitsPerSample;
  const frames = fileSource.frames;
  for (let start = 0; start < frames; start += blockFrames) {
    const n = Math.min(blockFrames, frames - start);
    // Decode by frame range through the existing FileSource path.
    const block = fileSource.read(start, n);
    const codes = new Int32Array(n * channels);
    const scale = Math.pow(2, bits - 1);
    for (let i = 0; i < codes.length; i++) {
      const v = block[i] * scale;
      codes[i] = Math.round(v);
    }
    yield { start, frames: n, codes };
  }
}

/**
 * Compare an exported WAV or FLAC file against regenerated expected codes.
 * `decoder` is a function(start, frames) -> Int32Array of decoded codes.
 */
export function verifyPointwiseStreaming({
  totalFrames,
  channels,
  blockFrames = 65536,
  source,
  gain,
  bits,
  dither,
  seed,
  decodeBlock,
}) {
  const q = new IntegerQuantizer({ bits, gain, dither, seed });
  let mismatches = 0;
  let firstMismatch = null;
  let maxAbsDiff = 0;
  let compared = 0;
  for (let start = 0; start < totalFrames; start += blockFrames) {
    const n = Math.min(blockFrames, totalFrames - start);
    const srcBlock = source.read(start, n);
    const expected = q.processBlock(srcBlock, start, channels);
    const actual = decodeBlock(start, n);
    for (let i = 0; i < n * channels; i++) {
      const diff = actual[i] - expected[i];
      if (diff !== 0) {
        mismatches++;
        if (!firstMismatch) {
          const frame = start + Math.floor(i / channels);
          firstMismatch = { frame, channel: i % channels, expected: expected[i], actual: actual[i] };
        }
      }
      const a = Math.abs(diff);
      if (a > maxAbsDiff) maxAbsDiff = a;
    }
    compared += n * channels;
  }
  return {
    ok: mismatches === 0 && compared === totalFrames * channels,
    samplesCompared: compared,
    mismatches,
    firstMismatch,
    maxAbsDiff,
  };
}
