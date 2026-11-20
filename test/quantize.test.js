import test from 'node:test';
import assert from 'node:assert/strict';
import { IntegerQuantizer } from '../src/core/quantize.js';
import { uniform01, tpdf, rpdf } from '../src/core/hash.js';
import { tailThenTransient, mulberry32 } from '../src/fixtures.js';

test('hash values are deterministic and bounded', () => {
  for (let f = 0; f < 200; f++) {
    for (let c = 0; c < 2; c++) {
      const u = uniform01(0x1234, f, c, 0);
      assert.equal(u, uniform01(0x1234, f, c, 0));
      assert.ok(u >= 0 && u < 1);
      const t = tpdf(0x1234, f, c);
      assert.ok(t > -1 && t < 1);
      const r = rpdf(0x1234, f, c);
      assert.ok(r > -0.5 && r < 0.5);
    }
  }
  assert.notEqual(uniform01(1, 5, 0, 0), uniform01(2, 5, 0, 0));
});

test('dither sequence is identical for any blocking of the input', () => {
  const { samples, channels } = tailThenTransient({ quietSeconds: 0.02, afterSeconds: 0.01, transientFrames: 8 });
  const opts = { bits: 16, gain: 0.7, dither: 'tpdf', seed: 0xdeadbeef };

  const whole = new IntegerQuantizer(opts).processBlock(samples, 0, channels);

  for (const chunk of [1, 2, 3, 7, 64, 997]) {
    const q = new IntegerQuantizer(opts);
    const out = new Int32Array(samples.length);
    for (let start = 0; start < samples.length / channels; start += chunk) {
      const n = Math.min(chunk, samples.length / channels - start);
      const block = samples.slice(start * channels, (start + n) * channels);
      out.set(q.processBlock(block, start, channels), start * channels);
    }
    assert.deepEqual(Buffer.from(out.buffer), Buffer.from(whole.buffer), `chunk ${chunk} differs`);
  }
});

test('dither is keyed by absolute frame, not by call-local index', () => {
  const q = new IntegerQuantizer({ bits: 16, gain: 1, dither: 'tpdf', seed: 42 });
  const block = new Float64Array([0, 0, 0, 0]);
  const atTen = q.processBlock(block, 10, 2);
  const atTenAgain = q.processBlock(block, 10, 2);
  assert.deepEqual([...atTen], [...atTenAgain]);
  const atZero = q.processBlock(block, 0, 2);
  assert.notDeepEqual([...atZero], [...atTen]);
});

test('gain is applied inside the quantiser', () => {
  const src = Float64Array.of(0.5, -0.5, 0.25, -0.25);
  const a = new IntegerQuantizer({ bits: 16, gain: 1, dither: 'none', seed: 0 }).processBlock(src, 0, 2);
  const b = new IntegerQuantizer({ bits: 16, gain: 0.5, dither: 'none', seed: 0 }).processBlock(src, 0, 2);
  assert.deepEqual([...a], [16384, -16384, 8192, -8192]);
  assert.deepEqual([...b], [8192, -8192, 4096, -4096]);
});

test('dither reduces correlated quantisation error (effective bits stay high)', () => {
  const n = 48000;
  const rnd = mulberry32(7);
  const src = new Float64Array(n);
  for (let i = 0; i < n; i++) src[i] = (rnd() * 2 - 1) * 0.5;
  const q = new IntegerQuantizer({ bits: 16, gain: 1, dither: 'tpdf', seed: 99 });
  q.processBlock(src, 0, 1);
  const s = q.summary();
  assert.equal(s.quantOutliers, 0);
  // Error here is dither + rounding, so RMS sits near sqrt(1/6 + 1/12) ~ 0.5 LSB.
  assert.ok(s.rmsQuantErrorLsb > 0.4 && s.rmsQuantErrorLsb < 0.55, `rms ${s.rmsQuantErrorLsb}`);
  assert.ok(s.effectiveBitsEstimate > 15 && s.effectiveBitsEstimate <= 16, `eff ${s.effectiveBitsEstimate}`);
});

test('overflow fail mode refuses to clip silently', () => {
  const q = new IntegerQuantizer({ bits: 16, gain: 2, dither: 'none', seed: 0, overflow: 'fail' });
  assert.throws(() => q.processBlock(Float64Array.of(0.75), 0, 1), /clipping at frame 0/);
});
