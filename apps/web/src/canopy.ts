// Deterministic randomness for everything drawn from a seed.

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

// The crown artwork (public/crown.webp): 1024 x 538 px, its trunk base at the
// bottom centre.
export const CROWN = { width: 1000, height: 525 } as const;
