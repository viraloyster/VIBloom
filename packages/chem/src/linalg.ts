// Dense LU with partial pivoting, sized for the small systems in this package.

export interface LU {
  lu: number[][];
  piv: number[];
}

export function luFactor(a: number[][]): LU | null {
  const n = a.length;
  const lu = a.map((r) => r.slice());
  const piv = Array.from({ length: n }, (_, i) => i);
  for (let k = 0; k < n; k++) {
    let p = k;
    let best = Math.abs(lu[k]![k]!);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(lu[i]![k]!);
      if (v > best) {
        best = v;
        p = i;
      }
    }
    if (best === 0 || !Number.isFinite(best)) return null;
    if (p !== k) {
      [lu[p], lu[k]] = [lu[k]!, lu[p]!];
      [piv[p], piv[k]] = [piv[k]!, piv[p]!];
    }
    const rk = lu[k]!;
    for (let i = k + 1; i < n; i++) {
      const ri = lu[i]!;
      const m = (ri[k]! /= rk[k]!);
      for (let j = k + 1; j < n; j++) ri[j]! -= m * rk[j]!;
    }
  }
  return { lu, piv };
}

export function luSolve(f: LU, b: readonly number[]): number[] {
  const n = b.length;
  const x = f.piv.map((p) => b[p]!);
  for (let i = 0; i < n; i++) {
    const r = f.lu[i]!;
    for (let j = 0; j < i; j++) x[i]! -= r[j]! * x[j]!;
  }
  for (let i = n - 1; i >= 0; i--) {
    const r = f.lu[i]!;
    for (let j = i + 1; j < n; j++) x[i]! -= r[j]! * x[j]!;
    x[i]! /= r[i]!;
  }
  return x;
}
