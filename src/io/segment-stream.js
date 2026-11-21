// Resumable segmented streaming.
//
// A conversion can be paused between blocks and resumed later, and a sink write
// can fail on the last, partially-filled block. Two objects own the state that
// makes that safe:
//
//   * SegmentIndex  – only ever records ranges whose bytes landed on the sink.
//                     It owns the absolute frame ranges the quantiser hands
//                     over; nothing can be declared retrievable until the write
//                     for that range has succeeded.
//   * SegmentConcatenator – splices the byte parts back in absolute-frame
//                     order and can pull audio across a segment boundary,
//                     overlapping both sides, so a seam can be diffed against
//                     the uninterrupted track sample by sample.
//
// Both are container agnostic: they track frames and byte ranges, never sample
// semantics. The reader that turns bytes back into codes lives in fidelity.js.

/**
 * Maps absolute frame ranges to byte parts held by a sink. Ranges are
 * normalised into a sorted, non-overlapping interval map, so retries that
 * rewrite the same frames merge instead of double counting.
 */
export class SegmentIndex {
  constructor({ channels, sampleRate, container } = {}) {
    if (!(channels >= 1)) throw new RangeError('SegmentIndex needs a channel count');
    this.channels = channels;
    this.sampleRate = sampleRate || null;
    this.container = container || null;
    /** @type {Array<{start:number, end:number, byteOffset:number, byteLength:number, part:number}>} */
    this.intervals = [];
    this.totalCommittedFrames = 0;
    this.failedWrites = [];
    this.nextPart = 0;
  }

  /**
   * Record that [startFrame, startFrame+frames) was written. The call must
   * happen *after* the sink write succeeded; a failed write goes through
   * recordFailure instead and never makes the range retrievable.
   *
   * Adjacent parts are kept as separate intervals even though their frame
   * ranges touch, because the concatenator pulls across the part boundary and
   * must be able to name which physical part each sample came from. Only true
   * overlaps (a retried write covering the same frames) merge.
   */
  commit(startFrame, frames, byteOffset, byteLength) {
    if (!Number.isInteger(startFrame) || !Number.isInteger(frames) || frames <= 0) {
      throw new RangeError(`commit: bad range start=${startFrame} frames=${frames}`);
    }
    const incoming = { start: startFrame, end: startFrame + frames, byteOffset, byteLength, part: this.nextPart++ };
    const merged = [];
    let cur = incoming;
    for (const iv of this.intervals) {
      const overlaps = iv.start < cur.end && cur.start < iv.end;
      if (!overlaps) {
        merged.push(iv);
        continue;
      }
      // Overlapping retry: span both ranges, keep the earliest byte offset.
      cur = {
        start: Math.min(cur.start, iv.start),
        end: Math.max(cur.end, iv.end),
        byteOffset: Math.min(cur.byteOffset, iv.byteOffset),
        byteLength: Math.max(cur.byteOffset + cur.byteLength, iv.byteOffset + iv.byteLength) - Math.min(cur.byteOffset, iv.byteOffset),
        part: Math.min(cur.part, iv.part),
      };
    }
    merged.push(cur);
    merged.sort((a, b) => a.start - b.start || a.byteOffset - b.byteOffset);
    this.intervals = merged;
    this.totalCommittedFrames = merged.reduce((n, iv) => n + (iv.end - iv.start), 0);
    return incoming;
  }

  /** A write of [startFrame, startFrame+frames) failed; nothing is committed. */
  recordFailure(startFrame, frames, error) {
    this.failedWrites.push({ start: startFrame, end: startFrame + frames, error: error?.message || String(error), at: Date.now() });
  }

  /** Drop every committed range at or after `frame` (used when retrying a tail). */
  rollbackTo(frame) {
    const kept = [];
    for (const iv of this.intervals) {
      if (iv.end <= frame) {
        kept.push(iv);
      } else if (iv.start < frame) {
        const keptFrames = frame - iv.start;
        const bytesPerFrame = iv.byteLength / (iv.end - iv.start);
        kept.push({ ...iv, end: frame, byteLength: Math.round(keptFrames * bytesPerFrame) });
      }
    }
    this.intervals = kept;
    this.totalCommittedFrames = kept.reduce((n, iv) => n + (iv.end - iv.start), 0);
  }

  /** Absolute frame at which the next write must begin for a gap-free stream. */
  get contiguousEnd() {
    let end = 0;
    for (const iv of this.intervals) {
      if (iv.start > end) break;
      end = iv.end;
    }
    return end;
  }

  /** True only when every frame in [start, end) was written successfully. */
  isRangeAvailable(start, end) {
    let cursor = start;
    for (const iv of this.intervals) {
      if (iv.start > cursor) return false;
      if (iv.end >= end) return iv.start <= cursor;
      if (iv.end > cursor) cursor = iv.end;
    }
    return cursor >= end;
  }

  /**
   * The index must not announce the whole segment as retrievable when the
   * final partial block failed. This returns the committed prefix length and
   * explicitly reports the missing tail.
   */
  availability(expectedFrames) {
    const end = this.contiguousEnd;
    const complete = end >= expectedFrames && this.intervals.length > 0;
    return {
      complete,
      committedFrames: end,
      expectedFrames,
      missingFrom: complete ? -1 : end,
      missingFrames: Math.max(0, expectedFrames - end),
      gaps: this.gaps(expectedFrames),
    };
  }

  gaps(expectedFrames) {
    const out = [];
    let cursor = 0;
    for (const iv of this.intervals) {
      if (iv.start > cursor) out.push({ start: cursor, end: iv.start });
      cursor = Math.max(cursor, iv.end);
    }
    if (cursor < expectedFrames) out.push({ start: cursor, end: expectedFrames });
    return out;
  }

  /** Interval containing `frame`, or null when that frame was never written. */
  intervalFor(frame) {
    for (const iv of this.intervals) {
      if (frame >= iv.start && frame < iv.end) return iv;
    }
    return null;
  }

  summary() {
    return {
      channels: this.channels,
      sampleRate: this.sampleRate,
      container: this.container,
      parts: this.intervals.length,
      committedFrames: this.contiguousEnd,
      totalCommittedFrames: this.totalCommittedFrames,
      failedWrites: this.failedWrites.length,
      intervals: this.intervals.map((iv) => ({ start: iv.start, end: iv.end, byteOffset: iv.byteOffset, byteLength: iv.byteLength })),
    };
  }
}

/**
 * Joins the byte parts described by a SegmentIndex back into one payload and
 * pulls decoded frames across segment seams. All reads go through the sink the
 * bytes were actually written to — nothing is cached from the failed attempt.
 */
export class SegmentConcatenator {
  /**
   * @param {SegmentIndex} index
   * @param {{read(offset:number, length:number):Uint8Array}} sink
   * @param {(bytes:Uint8Array, startFrame:number, frames:number) => Float64Array|Int32Array} decodePart
   *        Decodes one byte part into interleaved samples indexed from 0.
   */
  constructor(index, sink, decodePart) {
    this.index = index;
    this.sink = sink;
    this.decodePart = decodePart;
  }

  /**
   * Pull `frames` absolute frames starting at `startFrame`, spanning whatever
   * segment boundaries lie inside the range. Returns interleaved samples plus
   * the source interval of every frame, so callers can see which segment each
   * sample came from.
   */
  pull(startFrame, frames) {
    const channels = this.index.channels;
    const out = new Float64Array(frames * channels);
    const origin = new Int32Array(frames); // part number each frame came from
    let filled = 0;
    let cursor = startFrame;
    const end = startFrame + frames;
    while (cursor < end) {
      const iv = this.index.intervalFor(cursor);
      if (!iv) throw new Error(`pull: frame ${cursor} is not committed in the segment index`);
      const take = Math.min(iv.end, end) - cursor;
      const localFrame = cursor - iv.start;
      const bytes = this.sink.read(iv.byteOffset, iv.byteLength);
      const decoded = this.decodePart(bytes, iv.start, iv.end - iv.start);
      out.set(decoded.subarray(localFrame * channels, (localFrame + take) * channels), filled * channels);
      for (let i = 0; i < take; i++) origin[filled + i] = iv.part;
      filled += take;
      cursor += take;
    }
    return { samples: out, origin, frames, channels, startFrame };
  }

  /**
   * Pull overlapping audio around a seam: `before` frames on the committed
   * side and `after` frames on the resumed side. The two sides come from
   * different sink parts, so a duplicated or dropped sample shows up here.
   */
  pullAcrossSeam(seamFrame, before, after) {
    const left = this.pull(seamFrame - before, before);
    const right = this.pull(seamFrame, after);
    const seamPart = this.index.intervalFor(seamFrame)?.part ?? -1;
    const leftPart = this.index.intervalFor(seamFrame - 1)?.part ?? -1;
    return {
      seamFrame,
      left: left.samples,
      right: right.samples,
      leftPart,
      seamPart,
      crossesPartBoundary: leftPart !== seamPart,
    };
  }

  /** Concatenate every committed part in absolute-frame order into one buffer. */
  assemblePayload() {
    const parts = this.index.intervals;
    const total = parts.reduce((n, iv) => n + iv.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const iv of parts) {
      out.set(this.sink.read(iv.byteOffset, iv.byteLength), off);
      off += iv.byteLength;
    }
    return out;
  }
}

/**
 * Locate the first sample where two interleaved tracks disagree, with the
 * absolute frame and channel. Returns null when they are identical over the
 * compared range. This is the seam/oracle alignment primitive: a duplicated
 * sample reports the frame where the repetition starts, a dropped sample the
 * frame where the streams first drift apart.
 */
export function firstDivergence(expected, actual, { startFrame = 0, channels = 1 } = {}) {
  const n = Math.min(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    if (expected[i] !== actual[i]) {
      return {
        index: i,
        frame: startFrame + Math.floor(i / channels),
        channel: i % channels,
        expected: expected[i],
        actual: actual[i],
      };
    }
  }
  if (expected.length !== actual.length) {
    return { index: n, frame: startFrame + Math.floor(n / channels), channel: n % channels, expected: expected[n], actual: actual[n], lengthOnly: true };
  }
  return null;
}

/**
 * Align a resumed track against the uninterrupted oracle by searching a small
 * lag window around the seam. The lag is the content offset of the resumed
 * track relative to the oracle at the same frame:
 *
 *   lag -1 -> resumed[f] == oracle[f+1]: the resume skipped one source sample,
 *             i.e. a sample was dropped;
 *   lag +1 -> resumed[f] == oracle[f-1]: the resume repeated the sample before
 *             the seam, i.e. a sample was duplicated.
 */
export function locateSeamDefect(oracle, resumed, { seamFrame, channels = 1, searchRadius = 8 } = {}) {
  const direct = firstDivergence(
    oracle.subarray(seamFrame * channels, (seamFrame + searchRadius + 1) * channels),
    resumed.subarray(seamFrame * channels, (seamFrame + searchRadius + 1) * channels),
    { startFrame: seamFrame, channels },
  );
  if (!direct) return { kind: 'clean', firstDivergence: null, lag: 0 };

  // For each candidate lag, line up resumed[f] with oracle[f - lag] over a
  // fixed comparison window starting at the seam.
  const compareFrames = searchRadius;
  for (const lag of [-1, 1, -2, 2]) {
    const oracleStart = seamFrame - lag;
    const resumedStart = seamFrame;
    if (oracleStart < 0 || oracleStart + compareFrames > oracle.length / channels) continue;
    const a = oracle.subarray(oracleStart * channels, (oracleStart + compareFrames) * channels);
    const b = resumed.subarray(resumedStart * channels, (resumedStart + compareFrames) * channels);
    let equal = true;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) { equal = false; break; }
    }
    if (equal) {
      return {
        kind: lag < 0 ? 'dropped-sample' : 'duplicated-sample',
        lag,
        firstDivergence: direct,
        seamFrame,
      };
    }
  }
  return { kind: 'mismatch', lag: 0, firstDivergence: direct, seamFrame };
}
