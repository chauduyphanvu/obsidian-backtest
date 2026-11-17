// A small seeded random generator, so every check gives the same answer for the same seed.

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform whole number in [0, n). */
  int(n: number): number;
}

/** sfc32, with its state filled from the seed by splitmix32. */
export function makeRng(seed: number): Rng {
  let s = seed >>> 0;
  const split = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = split();
  let b = split();
  let c = split();
  let d = split();
  const next32 = () => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t;
  };
  for (let i = 0; i < 12; i++) next32();
  return {
    next: () => next32() / 4294967296,
    int: (n) => Math.floor((next32() / 4294967296) * n),
  };
}

/** Fisher–Yates, in place. */
export function shuffle<T>(xs: T[], rng: Rng): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}
