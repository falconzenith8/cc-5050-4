// Browser front end. Imports the same modules the CLI uses, so the conversion,
// dither, quantisation, FLAC/WAV encoding and verification code is identical.

import { convertAsync, Uint8Sink } from '/src/convert.js';
import { verifyExport } from '/src/verify.js';
import { BlobSource } from '/public/blob-source.js';
import { tailThenTransient, extremes } from '/src/fixtures.js';
import { MemorySource } from '/src/io/sources.js';
import { IntegerQuantizer } from '/src/core/quantize.js';
import { decodeContainer, compareDecoded } from '/src/compare.js';

const $ = (id) => document.getElementById(id);
const state = {
  source: null,
  sourceInfo: null,
  result: null,
  bytes: null,
  anomalies: [],
  anomalyIndex: -1,
  audioCtx: null,
  playing: null,
  decoded: null,
};

// ---------------------------------------------------------------- log
function log(msg, cls = '') {
  const el = $('log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------- bits menu
const TARGETS = {
  wav: [
    ['pcm', 8], ['pcm', 16], ['pcm', 24], ['pcm', 32], ['float', 32], ['float', 64],
  ],
  flac: [
    ['pcm', 8], ['pcm', 12], ['pcm', 16], ['pcm', 20], ['pcm', 24], ['pcm', 32],
  ],
};

function refreshBits() {
  const container = $('container').value;
  const fmt = $('sampleFormat').value;
  const bits = $('bits');
  const prev = Number(bits.value) || 24;
  bits.innerHTML = '';
  const options = TARGETS[container].filter(([f]) => f === fmt);
  if (options.length === 0) {
    // FLAC + float is invalid; snap back to PCM.
    $('sampleFormat').value = 'pcm';
    return refreshBits();
  }
  for (const [, b] of options) {
    const o = document.createElement('option');
    o.value = String(b);
    o.textContent = fmt === 'float' ? `float ${b}` : `PCM ${b}`;
    bits.appendChild(o);
  }
  if ([...bits.options].some((o) => Number(o.value) === prev)) bits.value = String(prev);
}

// ---------------------------------------------------------------- fixture
function makeFixture() {
  const fx = tailThenTransient({ quietSeconds: 1.0, quietDb: -90, transientFrames: 24, afterSeconds: 0.25, channels: 2 });
  const src = new MemorySource(fx.samples, { channels: 2, sampleRate: fx.sampleRate, label: 'built-in hard case' });
  src.describe = () => ({
    kind: 'fixture',
    name: 'quiet tail → full-scale transient',
    sampleFormat: 'float',
    bitsPerSample: 64,
    sampleRate: fx.sampleRate,
    channels: 2,
    frames: src.frames,
    duration: src.frames / fx.sampleRate,
    note: `transient at frame ${fx.peakFrame}`,
  });
  state.source = src;
  state.sourceInfo = src.describe();
  renderSourceInfo();
  log(`fixture: ${state.sourceInfo.frames} frames, transient at frame ${fx.peakFrame}`);
}

function makeExtremesFixture() {
  const ex = extremes();
  const src = new MemorySource(ex.samples, { channels: ex.channels, sampleRate: ex.sampleRate, label: 'extremes' });
  src.describe = () => ({ kind: 'fixture', name: 'extremes', sampleFormat: 'float', bitsPerSample: 64, sampleRate: ex.sampleRate, channels: ex.channels, frames: src.frames, duration: src.frames / ex.sampleRate });
  state.source = src;
  state.sourceInfo = src.describe();
  renderSourceInfo();
  log('fixture: extremes (rails, over-rails, NaN/±Inf)');
}

function renderSourceInfo() {
  const el = $('source-info');
  el.innerHTML = '';
  const info = state.sourceInfo;
  if (!info) return;
  const rows = [
    ['file', info.name || info.path || '—'],
    ['format', `${info.sampleFormat || '?'} ${info.bitsPerSample || ''} bit`],
    ['channels', info.channels],
    ['sample rate', `${info.sampleRate} Hz`],
    ['frames', info.frames],
    ['duration', `${(info.duration || 0).toFixed(6)} s`],
  ];  if (info.note) rows.push(['note', info.note]);
  if (info.truncated) rows.push(['warning', 'file was truncated; using frames actually present']);
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = String(v);
    el.append(dt, dd);
  }
}

async function onFile(file) {
  const rawFormat = $('rawFormat').value || null;
  const blobSrc = new BlobSource(file, { name: file.name, format: rawFormat });
  if (rawFormat) {
    blobSrc.channels = Number($('rawChannels').value) || 2;
    blobSrc.sampleRate = Number($('rawRate').value) || 48000;
  }
  try {
    await blobSrc.ready();
    state.source = blobSrc;
    state.sourceInfo = blobSrc.describe();
    renderSourceInfo();
    log(`loaded ${file.name}: ${state.sourceInfo.frames} frames, ${state.sourceInfo.channels} ch @ ${state.sourceInfo.sampleRate} Hz`);
  } catch (err) {
    log(`could not read ${file.name}: ${err.message}`, 'anom');
  }
}

// ---------------------------------------------------------------- convert
async function runConversion() {
  if (!state.source) {
    log('choose a file or the built-in fixture first', 'anom');
    return;
  }
  const container = $('container').value;
  const sampleFormat = $('sampleFormat').value;
  const bits = Number($('bits').value);
  const dither = sampleFormat === 'float' ? 'none' : $('dither').value;
  const seed = Number($('seed').value) >>> 0;
  const readFrames = Number($('chunk').value);
  const flacBlockSize = Number($('flacBlock').value);
  const gainMode = $('gainMode').value;
  const gainPolicy = { mode: gainMode };
  if (gainMode === 'fixed') gainPolicy.gainDb = Number($('gainDb').value);
  else gainPolicy.targetDb = Number($('targetDb').value);

  $('run').disabled = true;
  $('progress').textContent = 'analysing…';
  const t0 = performance.now();
  try {
    const sink = new Uint8Sink();
    const result = await convertAsync({
      source: state.source,
      target: { container, sampleFormat, bits, dither, seed, overflow: $('overflow').value },
      gainPolicy,
      readFrames,
      flacBlockSize,
      sink,
      onProgress: (p) => {
        $('progress').textContent = `${Math.round(p * 100)}%`;
      },
    });
    // convertAsync writes through the sink; recover the bytes for download.
    const bytes = sink.result();
    const report = result.report;
    report.output.bytes = bytes.length;
    report.output.sha256 = await sha256(bytes);

    state.result = result;
    state.bytes = bytes;
    state.anomalies = report.anomalies || [];
    state.anomalyIndex = -1;
    state.playhead = 0;
    state.decoded = null;
    state.sibling = null;

    // Verify with the in-browser decoder against regenerated codes.
    $('progress').textContent = 'verifying…';
    const verification = await verifyInBrowser({ bytes, container, report, bits, sampleFormat, dither, seed, readFrames });
    report.verification = verification;

    // Lossless paths additionally get the *other* container at the same depth,
    // so the two outputs can be compared pointwise and played as a difference.
    // This is what "play back the difference between the two outputs" means:
    // if both are truly lossless, the difference is digital silence.
    if (sampleFormat === 'pcm' && [8, 12, 16, 20, 24].includes(bits)) {
      $('progress').textContent = 'encoding sibling container…';
      try {
        const other = container === 'wav' ? 'flac' : 'wav';
        const sibSink = new Uint8Sink();
        await convertAsync({
          source: state.source,
          target: { container: other, sampleFormat, bits, dither, seed, overflow: $('overflow').value },
          gainPolicy: { mode: 'fixed', gain: report.gain.gain },
          readFrames,
          flacBlockSize,
          sink: sibSink,
        });
        const sibBytes = sibSink.result();
        const sibContainer = container === 'wav' ? 'flac' : 'wav';
        state.sibling = {
          bytes: sibBytes,
          mime: container === 'wav' ? 'audio/flac' : 'audio/wav',
          decoded: decodeContainerCodes(sibBytes, sibContainer),
        };
        const diff = compareContainers(decodeContainerCodes(bytes, container), state.sibling.decoded);
        report.containerDiff = diff;
      } catch (err) {
        log(`sibling container failed: ${err.message}`, 'anom');
      }
    }

    $('progress').textContent = 'decoding for playback…';
    await renderResult(report, bytes, verification);
    log(`converted ${report.output.frames} frames in ${(performance.now() - t0).toFixed(0)} ms; verification ${verification.ok ? 'PASS' : 'FAIL'}`);
  } catch (err) {
    console.error(err);
    log(`conversion failed: ${err.message}`, 'anom');
  } finally {
    $('run').disabled = false;
    $('progress').textContent = '';
  }
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Decode a whole produced container to integer codes; independent of the report. */
function decodeContainerCodes(bytes, container) {
  const d = decodeContainer(bytes, container);
  return { codes: d.data, channels: d.channels, sampleRate: d.sampleRate, bits: d.bits, frames: d.frames, kind: d.kind };
}

/** Pointwise compare of the two lossless containers. */
function compareContainers(a, b) {
  const c = compareDecoded(
    { kind: 'pcm', data: a.codes, channels: a.channels, bits: a.bits, frames: a.frames },
    { kind: 'pcm', data: b.codes, channels: b.channels, bits: b.bits, frames: b.frames },
  );
  return {
    compared: c.samplesCompared,
    lengthMatch: c.lengthMatch,
    mismatches: c.mismatches,
    maxAbsDiff: c.maxAbsDiff,
    firstMismatch: c.firstMismatch,
    identical: c.identical,
    detail: c.mismatches === 0
      ? `WAV and FLAC decode to identical integer codes across ${c.samplesCompared} samples; their difference is digital silence`
      : `${c.mismatches} differing samples, max |diff| ${c.maxAbsDiff}`,
  };
}

function verifyInBrowser({ bytes, container, report, bits, sampleFormat, dither, seed, readFrames }) {
  // Regenerate expected codes asynchronously, then reuse the shared verifier.
  return (async () => {
    let expected = null;
    if (sampleFormat === 'pcm') {
      const total = state.source.frames * state.source.channels;
      const codes = new Int32Array(total);
      const q = new IntegerQuantizer({ bits, gain: report.gain.gain, dither, seed });
      for (let start = 0; start < state.source.frames; start += readFrames) {
        const n = Math.min(readFrames, state.source.frames - start);
        const block = await state.source.read(start, n);
        codes.set(q.processBlock(block, start, state.source.channels), start * state.source.channels);
      }
      expected = { codes };
    } else {
      const total = state.source.frames * state.source.channels;
      const codes = new Float64Array(total);
      for (let start = 0; start < state.source.frames; start += readFrames) {
        const n = Math.min(readFrames, state.source.frames - start);
        const block = await state.source.read(start, n);
        for (let i = 0; i < n * state.source.channels; i++) {
          const v = block[i];
          codes[start * state.source.channels + i] = Number.isFinite(v) ? v * report.gain.gain : 0;
        }
      }
      expected = { codes };
    }
    return verifyExport({
      bytes,
      container,
      expected,
      report,
      pointwise: true,
      sampleRate: report.output.sampleRate,
      channels: report.output.channels,
      bits,
    });
  })();
}

async function renderResult(report, bytes, verification) {
  $('result-panel').hidden = false;
  const g = report.gain;
  const o = report.output;
  const cards = [
    ['Output', [
      ['container', o.container.toUpperCase() + (o.rf64 ? ' (RF64)' : '')],
      ['depth', `${report.target.bits}-bit ${report.target.sampleFormat}`],
      ['frames', o.frames],
      ['duration', `${o.durationSeconds.toFixed(6)} s`],
      ['bytes', o.bytes.toLocaleString()],
      ['sha256', report.output.sha256?.slice(0, 16) + '…'],
    ]],
    ['Gain (frozen)', [
      ['mode', g.mode],
      ['gain', `${g.gainDb.toFixed(6)} dB`],
      ['source peak', `${g.analysis.peakDb.toFixed(3)} dBFS`],
      ['peak at', `frame ${g.analysis.peakFrame}`],
      ['ceiling', `${(20 * Math.log10(g.targetCeiling)).toFixed(2)} dBFS`],
      ['late re-normalisation', 'never'],
    ]],
    ['Quantiser', report.quantiser ? [
      ['dither', report.target.dither],
      ['seed', report.target.seed],
      ['rms error', `${report.quantiser.rmsQuantErrorLsb.toFixed(4)} LSB`],
      ['eff. bits', report.quantiser.effectiveBitsEstimate.toFixed(2)],
      ['max error', `${report.quantiser.maxQuantErrorLsb.toFixed(3)} LSB`],
      ['outliers', report.quantiser.quantOutliers],
    ] : [['mode', 'float (no quantisation)'], ['dither', 'n/a']]],
    ['Clipping', report.clipping.mode === 'float-no-clamp' ? [
      ['policy', 'float, no clamp'],
      ['over full scale', report.clipping.overFullScaleSamples ? 'yes' : 'no'],
    ] : [
      ['policy', report.clipping.mode],
      ['overloads', report.clipping.overloadSamples],
      ['  positive', report.clipping.overloadPos],
      ['  negative', report.clipping.overloadNeg],
      ['full-scale clamps', report.clipping.fullScaleClamped],
    ]],
  ];
  const host = $('report-cards');
  host.innerHTML = '';
  for (const [title, rows] of cards) {
    const card = document.createElement('div');
    card.className = 'card';
    const h = document.createElement('h4');
    h.textContent = title;
    const dl = document.createElement('dl');
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = String(v);
      dl.append(dt, dd);
    }
    card.append(h, dl);
    host.appendChild(card);
  }

  const badge = $('verify-badge');
  badge.textContent = verification.ok ? 'PASS' : 'FAIL';
  badge.className = `badge ${verification.ok ? 'ok' : 'bad'}`;
  const list = $('checks');
  list.innerHTML = '';
  for (const c of verification.checks) {
    const li = document.createElement('li');
    li.className = c.ok ? 'pass' : 'fail';
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = c.ok ? '✔' : '✘';
    const text = document.createElement('span');
    text.textContent = `${c.name} — ${c.detail}`;
    li.append(mark, text);
    list.appendChild(li);
  }

  const ext = report.verification?.external;
  if (ext) {
    log(`external decoder: ${ext.available ? 'available' : 'not installed'}` + (ext.note ? ` (${ext.note})` : ''));
  }

  // Downloads
  const extName = report.target.container === 'flac' ? 'flac' : 'wav';
  const blob = new Blob([bytes], { type: report.target.container === 'flac' ? 'audio/flac' : 'audio/wav' });
  const url = URL.createObjectURL(blob);
  $('dl-target').href = url;
  $('dl-target').download = `master.${extName}`;
  if (state.sibling) {
    const sibName = report.target.container === 'flac' ? 'wav' : 'flac';
    $('dl-sibling').hidden = false;
    $('dl-sibling').href = URL.createObjectURL(new Blob([state.sibling.bytes], { type: state.sibling.mime }));
    $('dl-sibling').download = `master.${sibName}`;
  } else {
    $('dl-sibling').hidden = true;
  }
  const reportBlob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  $('dl-report').href = URL.createObjectURL(reportBlob);
  $('dl-report').download = `master.${extName}.report.json`;

  // Playback preparation
  state.targetBlob = blob;
  state.mime = report.target.container === 'flac' ? 'audio/flac' : 'audio/wav';
  try {
    await preparePlayback(report);
  } catch (err) {
    log(`could not decode output for playback: ${err.message}`, 'anom');
  }

  const cd = report.containerDiff;
  if (cd) {
    const li = document.createElement('li');
    li.className = cd.identical ? 'pass' : 'fail';
    li.innerHTML = '';
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = cd.identical ? '✔' : '✘';
    const text = document.createElement('span');
    text.textContent = `WAV vs FLAC containers — ${cd.detail}`;
    li.append(mark, text);
    list.appendChild(li);
    if (cd.identical) log('WAV and FLAC differ only in container: decoded codes are identical (difference is silence).');
    else log(`container difference found: ${cd.detail}`, 'anom');
  }
  const binOption = $('binDiffOption');
  binOption.hidden = !cd;
  binOption.disabled = !cd;
  if (!cd && $('listenMode').value === 'binDiff') $('listenMode').value = 'diff';

  const first = state.anomalies[0];
  const audible = state.anomalies.find((a) => a.kind === 'overload' || a.kind === 'full-scale-clamp' || a.kind === 'quant-error');
  // Requirement: land on the first clipping / quantisation defect so it can be
  // auditioned immediately. Non-finite events are still navigable, but a
  // clipping/quantisation event wins the initial landing when one exists.
  const landing = audible || first;
  if (landing) {
    state.anomalyIndex = state.anomalies.indexOf(landing);
    state.playhead = Math.max(0, landing.time - 0.25);
    $('anomaly-label').textContent = `${state.anomalyIndex + 1}/${state.anomalies.length}: ${landing.kind} at frame ${landing.frame} (${landing.time.toFixed(6)} s), ch ${landing.channel}`;
  } else {
    $('anomaly-label').textContent = 'no anomalies';
  }
  drawWaveform();
}

// ---------------------------------------------------------------- playback
async function preparePlayback(report) {
  // The exported file is decoded for listening. FLAC is decoded by our own
  // decoder so the browser does not need FLAC support for the diff view.
  const bytes = new Uint8Array(await state.targetBlob.arrayBuffer());
  const d = decodeContainer(bytes, report.target.container);
  const audio = await toAudioBuffer(d.data, d.channels, d.sampleRate, d.kind === 'pcm' ? d.bits : 0);
  state.decoded = { audio, channels: d.channels, sampleRate: d.sampleRate };
}

async function toAudioBuffer(data, channels, sampleRate, bits) {
  const ctx = getCtx();
  const frames = data.length / channels;
  const scale = bits > 0 ? Math.pow(2, bits - 1) : 1;
  const buf = ctx.createBuffer(channels, frames, sampleRate);
  for (let c = 0; c < channels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < frames; i++) ch[i] = data[i * channels + c] / scale;
  }
  return buf;
}

function getCtx() {
  if (!state.audioCtx) state.audioCtx = new AudioContext();
  return state.audioCtx;
}

async function buildListenBuffer(mode) {
  const rep = state.result.report;
  const ctx = getCtx();
  if (mode === 'target') return state.decoded.audio;
  // Source materialised at the frozen gain but not quantised, so target vs
  // source isolates exactly what the conversion did (rounding + dither).
  const channels = state.source.channels;
  const frames = state.source.frames;
  const src = ctx.createBuffer(channels, frames, state.source.sampleRate);
  const gain = rep.gain.gain;
  const readFrames = 16384;
  for (let start = 0; start < frames; start += readFrames) {
    const n = Math.min(readFrames, frames - start);
    const block = await state.source.read(start, n);
    for (let c = 0; c < channels; c++) {
      const ch = src.getChannelData(c);
      for (let i = 0; i < n; i++) {
        const v = block[i * channels + c];
        ch[start + i] = Number.isFinite(v) ? v * gain : 0;
      }
    }
  }
  return src;
}

async function buildDiffBuffer() {
  const rep = state.result.report;
  const ctx = getCtx();
  const target = state.decoded.audio;
  const channels = target.numberOfChannels;
  const frames = target.length;
  const diff = ctx.createBuffer(channels, frames, target.sampleRate);
  const gain = rep.gain.gain;
  const readFrames = 16384;
  for (let start = 0; start < frames; start += readFrames) {
    const n = Math.min(readFrames, frames - start);
    const block = await state.source.read(start, n);
    for (let c = 0; c < channels; c++) {
      const ch = diff.getChannelData(c);
      const tgt = target.getChannelData(c);
      for (let i = 0; i < n; i++) {
        const original = Number.isFinite(block[i * channels + c]) ? block[i * channels + c] * gain : 0;
        ch[start + i] = tgt[start + i] - original;
      }
    }
  }
  return diff;
}

/** WAV-decoded minus FLAC-decoded: digital silence iff both are lossless. */
async function buildContainerDiffBuffer() {
  const report = state.result.report;
  const sib = state.sibling?.decoded;
  if (!sib) throw new Error('no sibling container to compare');
  const primary = decodeContainerCodes(state.bytes, report.target.container);
  const ctx = getCtx();
  const channels = primary.channels;
  const frames = Math.min(primary.frames, sib.frames);
  const buf = ctx.createBuffer(channels, frames, primary.sampleRate);
  const scale = Math.pow(2, primary.bits - 1);
  for (let c = 0; c < channels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < frames; i++) {
      const a = primary.codes[i * channels + c];
      const b = sib.codes[i * channels + c];
      ch[i] = (a - b) / scale;
    }
  }
  return buf;
}

async function play() {
  const mode = $('listenMode').value;
  stop();
  const ctx = getCtx();
  await ctx.resume();
  let buffer;
  try {
    if (mode === 'target' || mode === 'source') buffer = await buildListenBuffer(mode);
    else if (mode === 'binDiff') buffer = await buildContainerDiffBuffer();
    else buffer = await buildDiffBuffer();
  } catch (err) {
    log(`cannot play ${mode}: ${err.message}`, 'anom');
    return;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  let node = src;
  if (mode === 'diff' || mode === 'binDiff') {
    const boost = Math.pow(10, Number($('diffBoost').value) / 20);
    const g = ctx.createGain();
    g.gain.value = boost;
    src.connect(g);
    node = g;
  }
  node.connect(ctx.destination);
  const startSec = Math.max(0, Math.min(state.playhead || 0, Math.max(0, buffer.duration - 0.01)));
  const secs = Number($('playSeconds').value) || 3;
  const dur = Math.min(secs, buffer.duration - startSec);
  src.start(0, startSec, Math.max(0.05, dur));
  state.playing = src;
  src.onended = () => { state.playing = null; };
  log(`playing ${mode} from ${startSec.toFixed(3)} s for ${dur.toFixed(2)} s`);
}

function stop() {
  if (state.playing) {
    try { state.playing.stop(); } catch { /* already stopped */ }
    state.playing = null;
  }
}

// ---------------------------------------------------------------- waveform
function drawWaveform() {
  if (!state.decoded) return;
  const canvas = $('wave');
  const ctx2d = canvas.getContext('2d');
  const { audio } = state.decoded;
  const W = canvas.width;
  const H = canvas.height;
  ctx2d.clearRect(0, 0, W, H);
  ctx2d.fillStyle = '#0b1017';
  ctx2d.fillRect(0, 0, W, H);
  const data = audio.getChannelData(0);
  const frames = data.length;
  const step = Math.max(1, Math.floor(frames / W));
  ctx2d.strokeStyle = '#4da3ff';
  ctx2d.globalAlpha = 0.85;
  ctx2d.beginPath();
  for (let x = 0; x < W; x++) {
    let min = 1;
    let max = -1;
    const s = x * step;
    for (let i = 0; i < step && s + i < frames; i++) {
      const v = data[s + i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = (1 - max) * (H / 2);
    const y2 = (1 - min) * (H / 2);
    ctx2d.moveTo(x + 0.5, y1);
    ctx2d.lineTo(x + 0.5, y2);
  }
  ctx2d.stroke();
  ctx2d.globalAlpha = 1;

  // anomalies
  for (const a of state.anomalies) {
    const x = Math.floor((a.frame / frames) * W);
    ctx2d.fillStyle = a.kind === 'non-finite' ? '#f5b642' : '#ff6b6b';
    ctx2d.fillRect(x, 0, Math.max(1, W / frames * 2), H);
  }
  // playhead
  if (state.playhead) {
    const x = Math.floor((state.playhead / (frames / audio.sampleRate)) * W);
    ctx2d.fillStyle = '#3ddc97';
    ctx2d.fillRect(x, 0, 1, H);
  }
  canvas.onclick = (e) => {
    const r = canvas.getBoundingClientRect();
    const frac = (e.clientX - r.left) / r.width;
    state.playhead = frac * (frames / audio.sampleRate);
    drawWaveform();
  };
}

function jumpAnomaly(dir) {
  if (!state.anomalies.length) return;
  if (dir > 0) state.anomalyIndex = Math.min(state.anomalies.length - 1, state.anomalyIndex + 1);
  else state.anomalyIndex = Math.max(0, state.anomalyIndex - 1);
  const a = state.anomalies[state.anomalyIndex];
  state.playhead = Math.max(0, a.time - 0.25);
  $('anomaly-label').textContent = `${state.anomalyIndex + 1}/${state.anomalies.length}: ${a.kind} at frame ${a.frame} (${a.time.toFixed(6)} s), ch ${a.channel}`;
  drawWaveform();
}

// ---------------------------------------------------------------- invariance
async function checkInvariance() {
  if (!state.source || !state.bytes) {
    log('convert something first', 'anom');
    return;
  }
  const report = state.result.report;
  const sizes = [1024, 8192, 65536];
  const out = [];
  for (const readFrames of sizes) {
    const sink = new Uint8Sink();
    const r = await convertAsync({
      source: state.source,
      target: {
        container: report.target.container,
        sampleFormat: report.target.sampleFormat,
        bits: report.target.bits,
        dither: report.target.dither,
        seed: report.target.seed,
        overflow: $('overflow').value,
      },
      // Reuse the exact frozen linear gain, not a dB round-trip, so the only
      // variable across these runs is the read chunk size.
      gainPolicy: report.gain.mode === 'fixed' ? { mode: 'fixed', gain: report.gain.gain } : { mode: 'scan', targetDb: report.gain.targetDb },
      readFrames,
      flacBlockSize: report.flac?.blockSize || 4096,
      sink,
    });
    const bytes = sink.result();
    out.push({ readFrames, bytes: bytes.length, sha: await sha256(bytes), gainDb: r.report.gain.gainDb });
  }
  const identical = out.every((o) => o.sha === out[0].sha);
  const text = out.map((o) => `chunk ${String(o.readFrames).padStart(6)} frames → ${o.bytes} bytes, gain ${o.gainDb.toFixed(6)} dB, sha256 ${o.sha.slice(0, 24)}…`).join('\n');
  $('invariance').textContent = `${text}\n\n${identical ? 'IDENTICAL: chunk size does not affect the output.' : 'DIFFERENT: output depends on chunk size (bug).'}`;
  $('invariance').classList.toggle('anom', !identical);
  log(`chunk invariance: ${identical ? 'identical' : 'DIFFERENT'} across ${sizes.join(', ')}`);
}

// ---------------------------------------------------------------- wiring
function bind() {
  $('container').addEventListener('change', refreshBits);
  $('sampleFormat').addEventListener('change', refreshBits);
  $('gainMode').addEventListener('change', () => {
    const fixed = $('gainMode').value === 'fixed';
    $('targetDbRow').hidden = fixed;
    $('gainDbRow').hidden = !fixed;
  });
  $('run').addEventListener('click', runConversion);
  $('genFixture').addEventListener('click', makeFixture);
  $('genExtremes').addEventListener('click', makeExtremesFixture);
  $('play').addEventListener('click', play);
  $('stop').addEventListener('click', stop);
  $('prevAnomaly').addEventListener('click', () => jumpAnomaly(-1));
  $('nextAnomaly').addEventListener('click', () => jumpAnomaly(1));
  $('checkInvariance').addEventListener('click', checkInvariance);
  $('diffBoost').addEventListener('input', () => { $('diffBoostLabel').textContent = `+${$('diffBoost').value} dB`; });
  $('file').addEventListener('change', (e) => { if (e.target.files[0]) onFile(e.target.files[0]); });

  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
  });

  refreshBits();
  log('ready');
}

bind();
