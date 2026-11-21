// Segmented conversion support.
//
// The conversion core already drives itself from absolute read requests and
// emits (codes, startFrame, frames) on fixed assembler boundaries. The sinks
// here make those writes observable so a run can be paused and resumed:
//
//   * TrackingSink wraps any sink and commits the assembler's absolute frame
//     range to a SegmentIndex only after the bytes land. A write that throws is
//     recorded as a failure and never becomes retrievable.
//   * FailOnceSink injects a single failure into one chosen frame range,
//     modelling a tail-block write error followed by a clean retry.
//
// Pauses are requested through the core's pauseAt/onPause options; the same
// ranges reach the index and the SegmentConcatenator unchanged.

import { Uint8Sink } from './convert.js';
import { SegmentIndex } from './io/segment-stream.js';

/**
 * Sink wrapper that mirrors writes to a SegmentIndex. The core's writeChunk
 * calls `write(bytes)` with no metadata, so the driver sets `pendingRange` to
 * the assembler's absolute {startFrame, frames} immediately before each write.
 */
export class TrackingSink {
  constructor({ channels, sampleRate, container, inner = new Uint8Sink() }) {
    this.inner = inner;
    this.index = new SegmentIndex({ channels, sampleRate, container });
    this.pendingRange = null;
    this.length = 0;
    this.writeLog = [];
  }

  write(bytes) {
    const range = this.pendingRange;
    if (!range) {
      // Container header / metadata and final size patches carry no audio
      // frames; pass them straight through without touching the index.
      this.inner.write(bytes);
      this.length = this.inner.length;
      return;
    }
    // Let an injected-failure inner sink see the same absolute range. Inner
    // sinks do not pre-declare the field, so assign unconditionally.
    this.inner.pendingRange = range;
    const offset = this.length;
    try {
      this.inner.write(bytes);
    } catch (err) {
      this.index.recordFailure(range.startFrame, range.frames, err);
      this.writeLog.push({ startFrame: range.startFrame, frames: range.frames, bytes: bytes.length, ok: false, error: err.message });
      throw err;
    }
    this.length = this.inner.length;
    this.index.commit(range.startFrame, range.frames, offset, bytes.length);
    this.writeLog.push({ startFrame: range.startFrame, frames: range.frames, bytes: bytes.length, ok: true });
    this.pendingRange = null;
  }

  patch(offset, bytes) {
    this.inner.patch(offset, bytes);
  }

  read(offset, length) {
    return this.inner.read(offset, length);
  }

  result() {
    return this.inner.result();
  }
}

/**
 * One-shot failing sink: the first write whose frame range contains
 * `failAtFrame` throws; every later write succeeds, modelling a tail-block
 * failure followed by a clean resume.
 */
export class FailOnceSink {
  constructor(inner = new Uint8Sink()) {
    this.inner = inner;
    this.length = 0;
    this.failAtFrame = null;
    this.fired = false;
    this.lastError = null;
  }

  arm(frame) {
    this.failAtFrame = frame;
    this.fired = false;
    this.lastError = null;
  }

  write(bytes) {
    if (this.failAtFrame !== null && !this.fired && this.pendingRange) {
      const r = this.pendingRange;
      if (r.startFrame <= this.failAtFrame && this.failAtFrame < r.startFrame + r.frames) {
        this.fired = true;
        this.lastError = new Error(`injected sink failure at frame ${this.failAtFrame} (write ${r.startFrame}..${r.startFrame + r.frames})`);
        throw this.lastError;
      }
    }
    this.inner.write(bytes);
    this.length = this.inner.length;
  }
  patch(offset, bytes) {
    this.inner.patch(offset, bytes);
  }

  read(offset, length) {
    return this.inner.read(offset, length);
  }

  result() {
    return this.inner.result();
  }
}

/**
 * Split a frame count into uneven segment lengths. Returns the boundary frame
 * offsets [0, len1, len1+len2, ..., total]; the pause/resume tests hand these
 * boundaries to the core's pauseAt so chunk lengths differ on every segment.
 */
export function unevenSegments(totalFrames, lengths) {
  const bounds = [0];
  let cursor = 0;
  let k = 0;
  while (cursor < totalFrames) {
    cursor = Math.min(totalFrames, cursor + lengths[k % lengths.length]);
    bounds.push(cursor);
    k++;
  }
  return bounds;
}
