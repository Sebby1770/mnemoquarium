/* Small maths the whole boat shares: clamps, damping, and seeded value noise
   for the seabed. Nothing here touches three.js, so it stays testable. */

import { fnv, Rng } from "./mnemo.js";

export const TAU = Math.PI * 2;

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
export function clamp01(v) { return clamp(v, 0, 1); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function invLerp(a, b, v) { return b === a ? 0 : (v - a) / (b - a); }
export function smoothstep(edge0, edge1, x) {
  const t = clamp01(invLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}
export function smootherstep(edge0, edge1, x) {
  const t = clamp01(invLerp(edge0, edge1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/* Frame-rate independent exponential approach. `rate` is roughly "how much of
   the gap is closed per second" expressed as a half-life-ish constant. */
export function damp(current, target, rate, dt) {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

export function moveTowards(current, target, maxDelta) {
  const d = target - current;
  return Math.abs(d) <= maxDelta ? target : current + Math.sign(d) * maxDelta;
}

export function wrapAngle(a) {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
}

export function randRange(rng, lo, hi) { return lo + rng.random() * (hi - lo); }
export function randInt(rng, lo, hi) { return lo + rng.randrange(Math.max(1, hi - lo + 1)); }

/* Weighted pick from [[value, weight], ...]. */
export function weightedPick(rng, pairs) {
  const total = pairs.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return pairs.length ? pairs[0][0] : null;
  let roll = rng.random() * total;
  for (const [value, weight] of pairs) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return pairs[pairs.length - 1][0];
}

export function makeRng(...parts) { return new Rng(fnv(parts)); }

/* Deterministic hash in [0,1) — the backbone of the value noise below. */
export function hash01(seed, x, y) {
  return fnv([seed, x, y]) / 4294967296;
}

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

/* Seeded 2D value noise in [-1, 1]. Not the fastest, but deterministic across
   machines, which is the whole point of a phrase-fed sea. */
export function valueNoise2D(seed, x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = fade(xf);
  const v = fade(yf);
  const a = hash01(seed, xi, yi);
  const b = hash01(seed, xi + 1, yi);
  const c = hash01(seed, xi, yi + 1);
  const d = hash01(seed, xi + 1, yi + 1);
  const top = lerp(a, b, u);
  const bottom = lerp(c, d, u);
  return lerp(top, bottom, v) * 2 - 1;
}

/* Fractal brownian motion over the value noise. */
export function fbm2D(seed, x, y, octaves = 4, lacunarity = 2.04, gain = 0.5) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i += 1) {
    sum += valueNoise2D(seed + i * 1013, x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/* Ridged noise — good for canyon walls and reef spines. */
export function ridge2D(seed, x, y, octaves = 4) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i += 1) {
    const n = 1 - Math.abs(valueNoise2D(seed + i * 7919, x * freq, y * freq));
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return norm > 0 ? sum / norm : 0;
}

export function formatCredits(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString("en-US");
}

export function formatDepth(m) {
  return `${Math.max(0, Math.round(m))} m`;
}

export function titleCase(s) {
  return String(s || "").replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/* hsl -> hex int, for species colours that come out of the engine as hues. */
export function hslHex(h, s, l) {
  const hh = ((h % 360) + 360) % 360 / 360;
  const ss = clamp01(s / 100);
  const ll = clamp01(l / 100);
  if (ss === 0) {
    const v = Math.round(ll * 255);
    return (v << 16) | (v << 8) | v;
  }
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const channel = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const r = Math.round(channel(hh + 1 / 3) * 255);
  const g = Math.round(channel(hh) * 255);
  const b = Math.round(channel(hh - 1 / 3) * 255);
  return (r << 16) | (g << 8) | b;
}
