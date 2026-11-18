// Random bars and series for checking indicators against a second implementation: prices on a coarse grid so values tie,
// stretches of identical bars, stretches with no volume, volume spikes and (with `gaps`) missing bars.

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Candles {
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

/** Sixteenths, which a float holds exactly, so equal sums of prices are equal numbers and ties are ties. */
export const grid = (x: number): number => Math.round(x * 16) / 16;

/** Random bars; with `gaps`, missing bars at the start and in the middle, all four values missing together. */
export function candles(seed: number, n: number, gaps: boolean): Candles {
  const u = rng(seed);
  const out: Candles = { h: [], l: [], c: [], v: [] };
  let px = 100;
  let flat = 0;
  let quiet = 0;
  for (let i = 0; i < n; i++) {
    if (flat === 0 && u() < 0.01) flat = 1 + Math.floor(u() * 30);
    if (quiet === 0 && u() < 0.01) quiet = 1 + Math.floor(u() * 30);
    let high = px;
    let low = px;
    let close = px;
    if (flat > 0) {
      flat--;
    } else {
      const open = grid(px * (1 + (u() - 0.5) * 0.01));
      close = grid(open * (1 + (u() - 0.5) * 0.04));
      high = grid(Math.max(open, close) * (1 + u() * 0.01));
      low = grid(Math.min(open, close) * (1 - u() * 0.01));
      high = Math.max(high, open, close);
      low = Math.min(low, open, close);
    }
    px = close;
    let volume = Math.round(1e5 + 9e5 * u());
    if (u() < 0.02) volume = Math.round(1e8 * u());
    if (quiet > 0) {
      quiet--;
      volume = 0;
    }
    out.h.push(high);
    out.l.push(low);
    out.c.push(close);
    out.v.push(volume);
  }
  if (gaps) {
    const missing = new Set<number>([0, 1, 2, 3, 4, 5, 6]);
    for (let k = 0; k < 6; k++) missing.add(1200 + Math.floor(u() * (n - 1200)));
    for (let k = 0; k < 4; k++) missing.add(1500 + k);
    for (const i of missing) for (const a of [out.h, out.l, out.c, out.v]) a[i] = NaN;
  }
  return out;
}

/** A series for the functions that take one: levels with ties and flat stretches, and (with `gaps`) holes anywhere. */
export function levels(seed: number, n: number, gaps: boolean): number[] {
  const u = rng(seed);
  const out: number[] = [];
  let x = 50;
  let flat = 0;
  for (let i = 0; i < n; i++) {
    if (flat === 0 && u() < 0.01) flat = 1 + Math.floor(u() * 25);
    if (flat > 0) flat--;
    else x = grid(Math.max(1, x * (1 + (u() - 0.5) * 0.05)));
    out.push(x);
  }
  if (gaps) {
    for (let i = 0; i < 5; i++) out[i] = NaN;
    for (let k = 0; k < 8; k++) out[5 + Math.floor(u() * (n - 5))] = NaN;
    for (let k = 0; k < 3; k++) out[2000 + k] = NaN;
  }
  return out;
}
