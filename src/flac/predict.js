// Prediction and Rice-cost planning for the FLAC encoder. All sample values
// are integers held in doubles (exact below 2^53).

export const FEATURES = {
  maxLpcOrder: 12,
  maxFixedOrder: 4,
  lpcPrecision: 15,
  maxRiceParam0: 14, // METHOD_PARTITIONED_RICE
  maxRiceParam1: 30, // METHOD_PARTITIONED_RICE2
  maxPartitionOrder: 4,
};

export function fixedResidual(x, n, order) {
  const r = new Float64Array(n);
  if (order === 0) {
    for (let i = 0; i < n; i++) r[i] = x[i];
  } else if (order === 1) {
    if (n > 0) r[0] = x[0];
    for (let i = 1; i < n; i++) r[i] = x[i] - x[i - 1];
  } else if (order === 2) {
    for (let i = 0; i < n; i++) r[i] = x[i] - (i > 0 ? 2 * x[i - 1] : 0) + (i > 1 ? x[i - 2] : 0);
  } else if (order === 3) {
    for (let i = 0; i < n; i++) {
      r[i] = x[i]
        - (i > 0 ? 3 * x[i - 1] : 0)
        + (i > 1 ? 3 * x[i - 2] : 0)
        - (i > 2 ? x[i - 3] : 0);
    }
  } else {
    for (let i = 0; i < n; i++) {
      r[i] = x[i]
        - (i > 0 ? 4 * x[i - 1] : 0)
        + (i > 1 ? 6 * x[i - 2] : 0)
        - (i > 2 ? 4 * x[i - 3] : 0)
        + (i > 3 ? x[i - 4] : 0);
    }
  }
  return r;
}

export function autocorrelation(x, n, maxLag) {
  const ac = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += x[i] * x[i - lag];
    ac[lag] = s;
  }
  return ac;
}

// Levinson-Durbin for the prediction convention x[i] ~= sum a[j] * x[i-j].
// Returns null when the recursion is ill-conditioned.
export function levinson(ac, order) {
  const a = new Float64Array(order + 1);
  const next = new Float64Array(order + 1);
  a[0] = 1;
  if (!(ac[0] > 0)) return null;
  let err = ac[0];
  for (let i = 1; i <= order; i++) {
    let acc = ac[i];
    for (let j = 1; j < i; j++) acc -= a[j] * ac[i - j];
    const k = acc / err;
    if (!Number.isFinite(k) || Math.abs(k) >= 1) return null;
    next[0] = 1;
    for (let j = 1; j < i; j++) next[j] = a[j] - k * a[i - j];
    next[i] = k;
    for (let j = 0; j <= i; j++) a[j] = next[j];
    err *= 1 - k * k;
    if (!(err > 0) || !Number.isFinite(err)) return null;
  }
  return a;
}

export function lpcResidual(x, n, order, coeffs, shift) {
  const r = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (i < order) {
      r[i] = x[i];
      continue;
    }
    let sum = 0;
    for (let j = 1; j <= order; j++) sum += coeffs[j] * x[i - j];
    r[i] = x[i] - Math.floor(sum / Math.pow(2, shift));
  }
  return r;
}

function countRiceBits(v, k) {
  const u = v < 0 ? -2 * v - 1 : 2 * v;
  return Math.floor(u / Math.pow(2, k)) + 1 + k;
}

function bestRiceParam(samples, offset, count, maxK) {
  let bestK = -1;
  let bestBits = Infinity;
  for (let k = 0; k <= maxK; k++) {
    let bits = 0;
    for (let i = 0; i < count; i++) bits += countRiceBits(samples[offset + i], k);
    if (bits < bestBits) {
      bestBits = bits;
      bestK = k;
    }
  }
  return { k: bestK, bits: bestBits };
}

// Search partition orders and Rice parameters. Returns null when the residual
// cannot be coded as signed 32-bit values (use verbatim instead).
//
// Partition layout per RFC 9639: partition p has (blocksize >> porder) samples,
// except partition 0, which has predictor_order fewer.
export function planResidual(res, n, order) {
  if (order >= n) return null;
  let maxAbs = 0;
  for (let i = order; i < n; i++) {
    const a = Math.abs(res[i]);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs > 2147483647) return null;

  const plans = [];
  for (let porder = 0; porder <= FEATURES.maxPartitionOrder; porder++) {
    const count = 1 << porder;
    if (n % count !== 0) break;
    const base = n / count;
    if (base <= order) break;
    const parts = [];
    let possible = true;
    for (let p = 0; p < count; p++) {
      // Residual sample 0 lives at res[order]; partition 0 is short by order.
      const offset = p === 0 ? order : p * base;
      const size = base - (p === 0 ? order : 0);
      if (size <= 0 || offset + size > n) {
        possible = false;
        break;
      }
      const { k, bits } = bestRiceParam(res, offset, size, FEATURES.maxRiceParam1);
      if (k < 0) {
        possible = false;
        break;
      }
      parts.push({ p, offset, size, k, bits });
    }
    if (!possible) break;
    plans.push({ porder, count, parts });
  }
  if (plans.length === 0) return null;

  let best = null;
  for (const plan of plans) {
    const rice2 = plan.parts.some((p) => p.k > FEATURES.maxRiceParam0);
    let bits = 2 + (rice2 ? 5 : 4);
    for (const part of plan.parts) bits += (rice2 ? 5 : 4) + part.bits;
    if (!best || bits < best.bits) best = { ...plan, bits, rice2 };
  }
  return best;
}

// Quantise LPC coefficients to `precision` bits with a non-negative shift.
export function quantizeLpc(a, order, precision) {
  let maxAbs = 0;
  for (let i = 1; i <= order; i++) maxAbs = Math.max(maxAbs, Math.abs(a[i]));
  if (maxAbs === 0) return { coeffs: new Float64Array(order + 1), shift: 0 };
  const maxShift = Math.min(15, precision - 2);
  let shift = Math.max(0, precision - 2 - Math.ceil(Math.log2(maxAbs)));
  shift = Math.min(shift, maxShift);
  const limit = Math.pow(2, precision - 1) - 1;
  const coeffs = new Float64Array(order + 1);
  coeffs[0] = 1;
  for (let i = 1; i <= order; i++) {
    let q = Math.round(a[i] * Math.pow(2, shift));
    if (q > limit) q = limit;
    if (q < -limit) q = -limit;
    coeffs[i] = q;
  }
  return { coeffs, shift };
}
