// Optional independent verification through ffmpeg/ffprobe. These are not
// part of the app's own decode path; they are a second opinion. When the
// binaries are missing the functions report `available: false` and callers
// carry on without them.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function findBinary(kind) {
  const env = kind === 'ffprobe' ? process.env.MFL_FFPROBE : process.env.MFL_FFMPEG;
  if (env && fs.existsSync(env)) return env;
  const candidates = [];
  if (kind === 'ffmpeg') {
    try { candidates.push(require('ffmpeg-static')); } catch { /* optional */ }
    try { candidates.push(require('@ffmpeg-installer/ffmpeg').path); } catch { /* optional */ }
    if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  } else {
    try { candidates.push(require('@ffprobe-installer/ffprobe').path); } catch { /* optional */ }
    if (process.env.FFPROBE_PATH) candidates.push(process.env.FFPROBE_PATH);
  }
  for (const c of [kind, `${kind}-bin`]) {
    const r = spawnSync('which', [c], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) candidates.push(r.stdout.trim());
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

export function externalTools() {
  return { ffmpeg: findBinary('ffmpeg'), ffprobe: findBinary('ffprobe') };
}

export function externalProbe(file) {
  const ffprobe = findBinary('ffprobe');
  if (!ffprobe) return { available: false, probe: null };
  const r = spawnSync(
    ffprobe,
    ['-v', 'error', '-select_streams', 'a:0', '-show_streams', '-show_format', '-of', 'json', file],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (r.status !== 0) return { available: true, probe: null, error: r.stderr.trim() };
  try {
    const json = JSON.parse(r.stdout);
    const s = json.streams?.[0] || {};
    const streamDuration = s.duration ? Number(s.duration) : undefined;
    const formatDuration = json.format?.duration ? Number(json.format.duration) : undefined;
    const duration = streamDuration ?? formatDuration;
    const durationSource = streamDuration !== undefined ? 'stream' : formatDuration !== undefined ? 'format' : 'none';
    return {
      available: true,
      probe: {
        path: file,
        codec: s.codec_name,
        sampleFormat: s.sample_fmt,
        sampleRate: Number(s.sample_rate),
        channels: s.channels,
        bitsPerRawSample: s.bits_per_raw_sample ? Number(s.bits_per_raw_sample) : null,
        frames: s.nb_frames ? Number(s.nb_frames) : undefined,
        // ffprobe often reports only duration for WAV; duration_ts * time_base
        // gives the authoritative sample count for these files.
        durationTs: s.duration_ts ? Number(s.duration_ts) : undefined,
        duration,
        durationSource,
        sampleCountEstimate:
          s.sample_rate && duration !== undefined
            ? s.duration_ts !== undefined && s.time_base
              ? Math.round(Number(s.duration_ts) * Number(s.time_base.split('/')[0]) / Number(s.time_base.split('/')[1]) * Number(s.sample_rate))
              : Math.round(Number(s.sample_rate) * duration)
            : undefined,
      },
    };
  } catch (e) {
    return { available: true, probe: null, error: e.message };
  }
}

const RAW_FMT = { wav: { u8: 'u8', pcm8: 'u8' } };

/**
 * Decode with ffmpeg into a canonical raw format. FLAC only goes up to 24-bit
 * in ffmpeg's encoder; ffmpeg's decoder also mis-handles 32-bit stereo, so for
 * >24-bit streams we return { skipped: reason } rather than a false mismatch.
 */
export function externalDecodeToRaw(file, container) {
  const ffmpeg = findBinary('ffmpeg');
  if (!ffmpeg) return { skipped: 'ffmpeg not installed' };
  const probe = externalProbe(file);
  if (!probe.probe) return { skipped: 'ffprobe could not read the file' };
  const p = probe.probe;
  const bits = p.bitsPerRawSample || (p.sampleFormat === 's16' ? 16 : p.sampleFormat === 's32' ? 24 : 16);
  if (p.sampleFormat === 's32' && bits > 24) {
    return {
      skipped: 'ffmpeg cannot round-trip >24-bit FLAC/WAV integer audio; use the built-in decoder and MD5',
      probe: p,
      reason: 'ffmpeg-32bit-limitation',
    };
  }
  let fmt;
  let width;
  if (p.sampleFormat === 'u8') { fmt = 'u8'; width = 1; }
  else if (p.sampleFormat === 's16') { fmt = 's16le'; width = 2; }
  else if (p.sampleFormat === 's32' && bits <= 24) { fmt = 's24le'; width = 3; }
  else if (p.sampleFormat === 's32') { fmt = 's32le'; width = 4; }
  else if (p.sampleFormat === 'flt') { fmt = 'f32le'; width = 4; }
  else if (p.sampleFormat === 'dbl') { fmt = 'f64le'; width = 8; }
  else return { skipped: `unhandled sample format ${p.sampleFormat}` };

  const tmp = path.join(os.tmpdir(), `mfl-verify-${process.pid}-${Date.now()}.raw`);
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-f', fmt, tmp, '-y'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { skipped: 'ffmpeg decode failed', error: r.stderr.trim(), probe: p };
  }
  const raw = fs.readFileSync(tmp);
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  const frames = Math.floor(raw.length / (width * p.channels));
  return {
    skipped: null,
    probe: p,
    frames,
    channels: p.channels,
    sampleRate: p.sampleRate,
    duration: frames / p.sampleRate,
    sampleFormat: fmt,
    bytes: raw.length,
    raw,
  };
}

export function externalToolsReport() {
  const t = externalTools();
  return {
    ffmpeg: t.ffmpeg ? { path: t.ffmpeg, version: versionOf(t.ffmpeg) } : null,
    ffprobe: t.ffprobe ? { path: t.ffprobe, version: versionOf(t.ffprobe) } : null,
  };
}

function versionOf(bin) {
  const r = spawnSync(bin, ['-version'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split('\n')[0].trim();
}
