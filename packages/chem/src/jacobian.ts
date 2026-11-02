import type { OdeSystem } from "./solver";

// Largest relative mismatch between J v and a central difference of the rhs
// along v, over the coordinate directions and one mixed direction.
export function jacobianMismatch(sys: OdeSystem, y: readonly number[], rel = 1e-6): number {
  const n = y.length;
  const J = sys.jac(y);
  const dirs: number[][] = Array.from({ length: n }, (_, i) => y.map((_, k) => (k === i ? 1 : 0)));
  dirs.push(y.map((_, k) => (k % 2 === 0 ? 1 : -0.5)));
  const size = Math.max(...y.map(Math.abs), 1e-300);
  let worst = 0;
  for (const v of dirs) {
    // Components at zero still get a step, relative to the size of the state.
    const h = y.map((yk, k) => rel * Math.max(Math.abs(yk), 1e-3 * size) * v[k]!);
    const plus = sys.rhs(y.map((yk, k) => yk + h[k]!));
    const minus = sys.rhs(y.map((yk, k) => yk - h[k]!));
    for (let r = 0; r < n; r++) {
      const fd = (plus[r]! - minus[r]!) / 2;
      const an = J[r]!.reduce((s, jrc, c) => s + jrc * h[c]!, 0);
      // Scale by the size of the terms so cancellation to zero is not an error.
      const scale = J[r]!.reduce((s, jrc, c) => s + Math.abs(jrc * h[c]!), 0);
      if (scale > 0) worst = Math.max(worst, Math.abs(fd - an) / scale);
    }
  }
  return worst;
}
