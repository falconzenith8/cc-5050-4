#!/usr/bin/env node
// Command line entry point.
//
//   node bin/mfl.js convert <input> --out <output> [options]
//   node bin/mfl.js verify  <file> [--json]
//   node bin/mfl.js fixtures <dir>
//
// Conversion streams to disk: the sink is flushed block by block, so peak
// memory stays proportional to the configured chunk sizes rather than the
// file length.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { FileSource } from '../src/io/file-source.js';
import { FileSink } from '../src/io/file-sink.js';
import { convert, expectedCodes, validateTarget } from '../src/convert.js';
import { verifyExport } from '../src/verify.js';
import { parseWavHeader, decodeWavSamples, readWavIntegerCode } from '../src/wav.js';
import { decodeFlac } from '../src/flac/decode.js';
import { externalProbe, externalDecodeToRaw, externalToolsReport } from '../tools/external.js';
import { verifyPointwiseStreaming } from '../src/io/verify-stream.js';
import { decodeContainer, compareDecoded } from '../src/compare.js';
import { makeFixtureSet } from '../tools/fixture-writer.js';

const USAGE = `master-format-lab

Usage:
  mfl convert <input> --out <file> [--container wav|flac] [--bits N]
              [--format pcm|float] [--dither none|tpdf|rpdf] [--seed N]
              [--gain-mode scan|fixed] [--target-db DB | --gain-db DB]
              [--overflow saturate|fail] [--chunk N] [--flac-block N]
              [--raw-format s16le|s24le|s32le|f32le|f64le|...]
              [--channels N] [--sample-rate N] [--report file.json]
              [--no-verify] [--no-pointwise]

  mfl verify <file> [--against <report.json>] [--json]

  mfl diff <fileA> <fileB> [--play-seconds N]

  mfl fixtures <dir>

If --container is omitted it follows the output extension. If --bits is
omitted it keeps the source integer width (float sources default to 24 bits).
`;

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      container: { type: 'string' },
      bits: { type: 'string' },
      format: { type: 'string' },
      dither: { type: 'string' },
      seed: { type: 'string' },
      'gain-mode': { type: 'string' },
      'gain-db': { type: 'string' },
      'target-db': { type: 'string' },
      overflow: { type: 'string' },
      chunk: { type: 'string' },
      'flac-block': { type: 'string' },
      'raw-format': { type: 'string' },
      channels: { type: 'string' },
      'sample-rate': { type: 'string' },
      report: { type: 'string' },
      'no-verify': { type: 'boolean' },
      'no-pointwise': { type: 'boolean' },
      json: { type: 'boolean' },
      against: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  return { values, positionals };
}

function extContainer(p) {
  const e = path.extname(p).toLowerCase();
  if (e === '.wav') return 'wav';
  if (e === '.flac') return 'flac';
  return null;
}

function cmdConvert({ values, positionals }) {
  const input = positionals[1];
  if (!input) throw new Error('convert: missing input path');
  if (!values.out) throw new Error('convert: --out is required');
  const container = values.container || extContainer(values.out) || extContainer(input) || 'wav';
  const source = new FileSource(input, {
    format: values['raw-format'],
    channels: values.channels ? Number(values.channels) : undefined,
    sampleRate: values['sample-rate'] ? Number(values['sample-rate']) : undefined,
  });

  try {
    const desc = source.describe();
    const wantedBits = values.bits ? Number(values.bits) : null;
    // A float source defaults to float output, but an explicit integer depth
    // (e.g. --bits 16) means the caller wants PCM. FLAC is integer-only.
    let sampleFormat;
    if (values.format) sampleFormat = values.format;
    else if (container === 'flac') sampleFormat = 'pcm';
    else if (desc.sampleFormat === 'float' && (wantedBits === null || wantedBits === 32 || wantedBits === 64)) sampleFormat = 'float';
    else sampleFormat = 'pcm';
    let bits;
    if (wantedBits) bits = wantedBits;
    else if (sampleFormat === 'float') bits = 32;
    else bits = Math.min(32, desc.bitsPerSample);
    if (sampleFormat === 'pcm' && ![8, 12, 16, 20, 24, 32].includes(bits)) throw new Error(`unsupported PCM width ${bits}`);
    if (sampleFormat === 'float' && ![32, 64].includes(bits)) throw new Error('float output must be 32 or 64 bits');

    const gainMode = values['gain-mode'] || (values['gain-db'] !== undefined ? 'fixed' : 'scan');
    const gainPolicy = { mode: gainMode };
    if (gainMode === 'fixed') {
      if (values['gain-db'] === undefined) throw new Error('--gain-mode fixed needs --gain-db');
      gainPolicy.gainDb = Number(values['gain-db']);
    } else {
      gainPolicy.targetDb = values['target-db'] !== undefined ? Number(values['target-db']) : -1;
    }

    validateTarget({ container, sampleFormat, bits, channels: desc.channels });

    const readFrames = values.chunk ? Number(values.chunk) : 65536;
    const flacBlock = values['flac-block'] ? Number(values['flac-block']) : 4096;
    const outPath = values.out;
    const tmpPath = `${outPath}.part`;

    // Stream straight to disk: the core only ever sees a sink interface, so
    // memory use stays tied to chunk sizes, not to file length.
    const outFd = fs.openSync(tmpPath, 'w+');
    let result;
    try {
      result = convert({
        source,
        target: {
          container,
          sampleFormat,
          bits,
          dither: values.dither || (sampleFormat === 'float' ? 'none' : 'tpdf'),
          seed: values.seed !== undefined ? Number(values.seed) : 0x5eed1234,
          overflow: values.overflow || 'saturate',
        },
        gainPolicy,
        readFrames,
        flacBlockSize: flacBlock,
        sink: new FileSink(outFd),
      });
      fs.fsyncSync(outFd);
    } finally {
      fs.closeSync(outFd);
    }
    fs.renameSync(tmpPath, outPath);

    const report = result.report;
    report.output.path = outPath;

    let verification = null;
    if (!values['no-verify']) {
      const bytes = fs.readFileSync(outPath);
      report.output.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      verification = verifyInternal({
        bytes,
        outPath,
        container,
        report,
        source,
        bits,
        sampleFormat,
        dither: report.target.dither,
        seed: report.target.seed,
        gain: report.gain.gain,
        pointwise: !values['no-pointwise'],
        readFrames,
      });
      const ext = externalVerify(outPath, container);
      verification.external = ext;
    } else {
      report.output.sha256 = crypto.createHash('sha256').update(fs.readFileSync(outPath)).digest('hex');
    }

    report.verification = verification;
    const reportPath = values.report || `${outPath}.report.json`;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    printSummary(report, reportPath);
    if (verification && !verification.ok) process.exitCode = 2;
  } finally {
    source.close();
  }
}

function verifyInternal({ bytes, outPath, container, report, source, bits, sampleFormat, dither, seed, gain, pointwise, readFrames }) {
  const STREAMING_THRESHOLD = 64 * 1024 * 1024;
  if (pointwise && outPath && bytes.length > STREAMING_THRESHOLD && container === 'wav') {
    // Large WAV: decode the file back block by block instead of holding a
    // second full copy in memory.
    const out = new FileSource(outPath);
    try {
      const pw = verifyPointwiseStreaming({
        totalFrames: out.frames,
        channels: out.channels,
        blockFrames: Math.max(readFrames, 1 << 20),
        source,
        gain,
        bits,
        dither,
        seed,
        decodeBlock: (start, n) => {
          const block = out.read(start, n);
          const codes = new Int32Array(n * out.channels);
          const scale = Math.pow(2, bits - 1);
          for (let i = 0; i < codes.length; i++) codes[i] = Math.round(block[i] * scale);
          return codes;
        },
      });
      const v = verifyExport({ bytes: bytes.subarray(0, 64), container, expected: null, report, pointwise: false, sampleRate: source.sampleRate, channels: source.channels, bits });
      // Re-run header-only structural checks against the file head.
      v.pointwise = { exact: pw.ok, samplesCompared: pw.samplesCompared, mismatches: pw.mismatches, firstDetail: pw.firstMismatch, maxAbsDiff: pw.maxAbsDiff, detail: pw.ok ? `${pw.samplesCompared} samples identical (streamed)` : `${pw.mismatches} mismatches` };
      v.checks.push({ name: 'pointwise sample values match expectation (streamed)', ok: pw.ok, detail: v.pointwise.detail });
      v.ok = v.checks.every((c) => c.ok);
      return v;
    } finally {
      out.close();
    }
  }

  let expected = null;
  if (pointwise && sampleFormat === 'pcm') {
    expected = expectedCodes({ source, gain, bits, dither, seed, readFrames: Math.max(1, Math.floor(readFrames / 3)) });
  } else if (pointwise) {
    const codes = new Float64Array(source.frames * source.channels);
    for (let start = 0; start < source.frames; start += readFrames) {
      const n = Math.min(readFrames, source.frames - start);
      const block = source.read(start, n);
      // Non-finite inputs are replaced by silence before the gain, matching
      // the conversion core's float path.
      for (let i = 0; i < n * source.channels; i++) {
        const v = block[i];
        codes[start * source.channels + i] = Number.isFinite(v) ? v * gain : 0;
      }
    }
    expected = { codes };
  }
  return verifyExport({
    bytes,
    container,
    expected,
    report,
    pointwise,
    sampleRate: source.sampleRate,
    channels: source.channels,
    bits,
  });
}

function externalVerify(outPath, container) {
  const probe = externalProbe(outPath);
  const result = { available: probe.available, probe: probe.probe, tools: externalToolsReport() };
  if (!probe.available) return result;
  const decoded = externalDecodeToRaw(outPath, container);
  result.decoded = decoded;
  if (probe.probe) {
    const expectedFrames = probe.probe.sampleCountEstimate ?? probe.probe.frames;
    result.frameCountMatchesProbe = decoded && !decoded.skipped && expectedFrames !== undefined ? decoded.frames === expectedFrames : null;
    result.durationMatchesProbe =
      decoded && !decoded.skipped && probe.probe.duration !== undefined
        ? Math.abs(decoded.duration - expectedFrames / decoded.sampleRate) < 1 / decoded.sampleRate
        : null;
    if (decoded.skipped) result.note = decoded.skipped;
  }
  return result;
}

function cmdVerify({ values, positionals }) {
  const file = positionals[1];
  if (!file) throw new Error('verify: missing path');
  const bytes = fs.readFileSync(file);
  const container = extContainer(file) || (bytes[0] === 0x66 ? 'flac' : 'wav');
  let report = null;
  if (values.against) report = JSON.parse(fs.readFileSync(values.against, 'utf8'));

  const v = verifyExport({ bytes, container, expected: null, report, pointwise: false });
  const ext = externalVerify(file, container);
  const out = { internal: v, external: ext };
  if (values.json) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    console.log(`file: ${file}`);
    for (const c of v.checks) console.log(`  [${c.ok ? 'ok' : 'FAIL'}] ${c.name}: ${c.detail}`);
    console.log(`  external: ${ext.available ? 'available' : 'not installed'}`);
    if (ext.available && ext.decoded) {
      console.log(`  external decoded frames: ${ext.decoded.frames}, ${ext.decoded.channels} ch @ ${ext.decoded.sampleRate} Hz`);
      if (ext.frameCountMatchesProbe !== null) console.log(`  [${ext.frameCountMatchesProbe ? 'ok' : 'FAIL'}] frame count matches ffprobe`);
      if (ext.durationMatchesProbe !== null) console.log(`  [${ext.durationMatchesProbe ? 'ok' : 'FAIL'}] duration matches ffprobe`);
    }
  }
  if (!v.ok) process.exitCode = 2;
}

function cmdDiff({ positionals }) {
  const [aPath, bPath] = positionals.slice(1);
  if (!aPath || !bPath) throw new Error('diff: two files are required');
  const aBytes = fs.readFileSync(aPath);
  const bBytes = fs.readFileSync(bPath);
  const aContainer = extContainer(aPath) || (aBytes[4] === 0x66 ? 'flac' : 'wav');
  const bContainer = extContainer(bPath) || (bBytes[4] === 0x66 ? 'flac' : 'wav');
  const a = decodeContainer(aBytes, aContainer);
  const b = decodeContainer(bBytes, bContainer);
  const cmp = compareDecoded(a, b);
  const lines = [
    `A: ${aPath} (${aContainer}) ${a.frames} frames, ${a.channels} ch @ ${a.sampleRate} Hz, ${a.bits} bit`,
    `B: ${bPath} (${bContainer}) ${b.frames} frames, ${b.channels} ch @ ${b.sampleRate} Hz, ${b.bits} bit`,
    `difference: ${cmp.detail}`,
    `  samples compared: ${cmp.samplesCompared}`,
    `  exact match: ${cmp.identical ? 'yes' : 'no'}`,
    `  max |diff|: ${cmp.maxAbsDiff}`,
  ];
  if (cmp.firstMismatch) lines.push(`  first mismatch: frame ${cmp.firstMismatch.frame} ch ${cmp.firstMismatch.channel}`);
  console.log(lines.join('\n'));
  if (!cmp.identical) process.exitCode = 2;
}

function cmdFixtures({ positionals }) {
  const dir = positionals[1] || 'fixtures';
  const made = makeFixtureSet(dir);
  for (const f of made) console.log(`${f.file}  ${f.note}`);
}

function printSummary(report, reportPath) {
  const g = report.gain;
  const o = report.output;
  const lines = [
    `wrote ${o.path}`,
    `  ${o.container.toUpperCase()} ${o.channels}ch @ ${o.sampleRate} Hz, ${report.target.bits} bit, ${o.frames} frames (${o.durationSeconds.toFixed(6)} s)`,
    `  gain ${g.gainDb.toFixed(6)} dB (${g.mode}), source peak ${g.analysis.peakDb.toFixed(3)} dBFS at frame ${g.analysis.peakFrame}`,
    `  sha256 ${o.sha256}`,
  ];
  if (report.clipping.mode !== 'float-no-clamp') {
    lines.push(`  clipping: ${report.clipping.overloadSamples} overload samples, ${report.clipping.fullScaleClamped} full-scale clamps`);
  }
  if (report.anomalies.length) {
    lines.push(`  first anomaly: ${report.anomalies[0].kind} at frame ${report.anomalies[0].frame} (${report.anomalies[0].time.toFixed(6)} s)`);
  }
  const v = report.verification;
  if (v) {
    lines.push(`  verification: ${v.ok ? 'PASS' : 'FAIL'} (${v.checks.length} checks)`);
    for (const c of v.checks) if (!c.ok) lines.push(`    FAIL ${c.name}: ${c.detail}`);
    if (v.external?.available) {
      const x = v.external;
      if (x.note) lines.push(`  external decoder: skipped (${x.note})`);
      else if (x.frameCountMatchesProbe !== null && x.frameCountMatchesProbe !== undefined) {
        lines.push(`  external decoder: frames ${x.decoded?.frames}, probe ~${x.probe?.sampleCountEstimate}${x.frameCountMatchesProbe ? ' (match)' : ' (MISMATCH)'}`);
      } else {
        lines.push('  external decoder: available, no probe metadata');
      }
    } else {
      lines.push('  external decoder: not installed');
    }
  }
  lines.push(`  report ${reportPath}`);
  console.log(lines.join('\n'));
}

const { values, positionals } = parse(process.argv.slice(2));
const cmd = positionals[0];
try {
  if (values.help || !cmd) {
    process.stdout.write(USAGE);
  } else if (cmd === 'convert') {
    cmdConvert({ values, positionals });
  } else if (cmd === 'verify') {
    cmdVerify({ values, positionals });
  } else if (cmd === 'diff') {
    cmdDiff({ values, positionals });
  } else if (cmd === 'fixtures') {
    cmdFixtures({ values, positionals });
  } else {
    process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
    process.exitCode = 1;
  }
} catch (err) {
  process.stderr.write(`error: ${err.message}\n`);
  if (process.env.MFL_DEBUG) process.stderr.write(err.stack + '\n');
  process.exitCode = 1;
}
