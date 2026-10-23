// Seeded PRNG. The simulation must never call Math.random() — client and server run the same
// code and have to reach the same answer. See docs/ARCHITECTURE.md §9.

/** mulberry32: small, fast, good enough, and identical in every JS engine. */
export function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randInt = (next, n) => (next() * n) | 0;
export const pick = (next, arr) => arr[randInt(next, arr.length)];
