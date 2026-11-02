// Halton points with a Cranley-Patterson rotation: low discrepancy, and a
// seed makes every sample reproducible.

const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19];

export function radicalInverse(index: number, base: number): number {
  let f = 1;
  let r = 0;
  for (let i = index; i > 0; i = Math.floor(i / base)) {
    f /= base;
    r += f * (i % base);
  }
  return r;
}

// Deterministic offsets in [0, 1) from a 32-bit seed (mulberry32).
export function rotation(seed: number, dims: number): number[] {
  let a = seed >>> 0;
  return Array.from({ length: dims }, () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
}

// Point i (from 1) of the rotated sequence in the unit cube.
export function halton(i: number, dims: number, shift: readonly number[]): number[] {
  if (dims > PRIMES.length) throw new RangeError("too many dimensions");
  return Array.from({ length: dims }, (_, d) => (radicalInverse(i, PRIMES[d]!) + shift[d]!) % 1);
}
