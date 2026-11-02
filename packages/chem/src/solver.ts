// Extrapolated linearly implicit Euler (SEULEX type) for small stiff systems.
// One Jacobian per macro step; substeps follow the harmonic sequence 1..K and
// are combined by Aitken-Neville extrapolation (error expansion in h).

import type { ExecutionFailure } from "@vibloom/contracts";
import { luFactor, luSolve } from "./linalg";

export type Vec = number[];

export interface OdeSystem {
  rhs: (y: readonly number[]) => Vec;
  jac: (y: readonly number[]) => number[][];
  // States outside the domain are rejected, never clipped.
  inDomain?: (y: readonly number[]) => boolean;
}

export interface SolveOptions {
  rtol: number;
  atol: number;
  h0?: number;
  hmax?: number;
  columns?: number;
  maxSteps?: number;
  maxRejected?: number;
  maxRhsEvals?: number;
}

export interface SolveStats {
  steps: number;
  rejected: number;
  rhsEvals: number;
  jacEvals: number;
  luDecomps: number;
}

export type SolveStatus = { status: "completed" } | { status: "failed"; reason: ExecutionFailure };

export interface Trajectory {
  t: number[];
  y: Vec[];
  stats: SolveStats;
  execution: SolveStatus;
}

type Rejection = "error" | "singular_system" | "non_finite" | "domain_exit";

export function solve(
  sys: OdeSystem,
  y0: readonly number[],
  t1: number,
  opt: SolveOptions,
): Trajectory {
  const K = opt.columns ?? 6;
  const n = y0.length;
  const hmax = opt.hmax ?? t1;
  const maxSteps = opt.maxSteps ?? 1_000_000;
  const maxRejected = opt.maxRejected ?? 100_000;
  const maxRhsEvals = opt.maxRhsEvals ?? 50_000_000;
  const stats: SolveStats = { steps: 0, rejected: 0, rhsEvals: 0, jacEvals: 0, luDecomps: 0 };
  const out: Trajectory = { t: [0], y: [y0.slice()], stats, execution: { status: "completed" } };
  const fail = (reason: ExecutionFailure) => {
    out.execution = { status: "failed", reason };
    return out;
  };

  if (!y0.every(Number.isFinite)) return fail("non_finite");
  if (sys.inDomain && !sys.inDomain(y0)) return fail("domain_exit");

  let t = 0;
  let y = y0.slice();
  let H = Math.min(opt.h0 ?? 1e-6, hmax, t1);
  let last: Rejection = "error";
  // A trajectory that keeps hitting the domain boundary, even as the step
  // shrinks, is leaving the domain; the count resets after two accepted steps.
  let domainHits = 0;
  let accepted = 0;

  while (t < t1) {
    if (stats.steps >= maxSteps || stats.rejected >= maxRejected || stats.rhsEvals >= maxRhsEvals) {
      return fail("budget_exhausted");
    }
    if (H < 1e-14 * Math.max(1, Math.abs(t))) {
      return fail(last === "error" ? "step_too_small" : last);
    }
    const lastStep = H >= t1 - t;
    if (lastStep) H = t1 - t;

    const J = sys.jac(y);
    stats.jacEvals++;
    const f0 = sys.rhs(y);
    stats.rhsEvals++;

    const T: Vec[][] = [];
    let rejection: Rejection | null = null;
    for (let j = 1; j <= K; j++) {
      const h = H / j;
      const lu = luFactor(J.map((row, r) => row.map((v, c) => (r === c ? 1 : 0) - h * v)));
      stats.luDecomps++;
      if (!lu) {
        rejection = "singular_system";
        break;
      }
      let yi = y.slice();
      for (let i = 0; i < j; i++) {
        const fi = i === 0 ? f0 : sys.rhs(yi);
        if (i > 0) stats.rhsEvals++;
        const d = luSolve(
          lu,
          fi.map((v) => h * v),
        );
        yi = yi.map((v, k) => v + d[k]!);
        if (!yi.every(Number.isFinite)) {
          rejection = "non_finite";
          break;
        }
      }
      if (rejection !== null) break;
      const row: Vec[] = [yi];
      const above = T[j - 2];
      for (let k = 1; k < j; k++) {
        const ratio = j / (j - k) - 1;
        const prev = row[k - 1]!;
        const up = above![k - 1]!;
        row.push(prev.map((v, m) => v + (v - up[m]!) / ratio));
      }
      T.push(row);
    }

    let err = Infinity;
    let next: Vec | null = null;
    if (rejection === null) {
      const top = T[K - 1]!;
      next = top[K - 1]!;
      const prev = top[K - 2] ?? T[0]![0]!;
      let sum = 0;
      for (let m = 0; m < n; m++) {
        const sc = opt.atol + opt.rtol * Math.max(Math.abs(y[m]!), Math.abs(next[m]!));
        const e = (next[m]! - prev[m]!) / sc;
        sum += e * e;
      }
      err = Math.sqrt(sum / n);
      if (!Number.isFinite(err)) rejection = "non_finite";
      else if (sys.inDomain && !sys.inDomain(next)) rejection = "domain_exit";
      else if (err > 1) rejection = "error";
    }

    if (rejection === null && next) {
      t = lastStep ? t1 : t + H;
      y = next;
      out.t.push(t);
      out.y.push(y);
      stats.steps++;
      if (++accepted >= 2) domainHits = 0;
      H = Math.min(H * stepFactor(err, K), hmax);
    } else {
      stats.rejected++;
      accepted = 0;
      last = rejection ?? "error";
      if (last === "domain_exit" && ++domainHits >= 10) return fail("domain_exit");
      H *= rejection === "error" ? Math.min(stepFactor(err, K), 0.5) : 0.25;
    }
  }
  return out;
}

function stepFactor(err: number, K: number) {
  return Math.min(4, Math.max(0.2, 0.9 * Math.pow(1 / Math.max(err, 1e-10), 1 / K)));
}

// Linear interpolation of one component on a uniform grid.
export function resample(tr: Trajectory, comp: number, dt: number): { t: number[]; v: number[] } {
  const t: number[] = [];
  const v: number[] = [];
  const end = tr.t[tr.t.length - 1] ?? 0;
  let k = 0;
  for (let i = 0; i * dt <= end + 1e-12; i++) {
    const s = i * dt;
    while (k < tr.t.length - 2 && tr.t[k + 1]! < s) k++;
    const ta = tr.t[k]!;
    const tb = tr.t[k + 1] ?? ta;
    const a = tr.y[k]![comp]!;
    const b = (tr.y[k + 1] ?? tr.y[k]!)[comp]!;
    t.push(s);
    v.push(tb > ta ? a + ((s - ta) / (tb - ta)) * (b - a) : a);
  }
  return { t, v };
}
