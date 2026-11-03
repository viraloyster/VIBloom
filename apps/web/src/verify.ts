// "Verify it yourself": the browser runs the same solver on the same point and
// compares what it gets with what the engine recorded.

import {
  evaluatePoint,
  initialState,
  model,
  resample,
  solve,
  type InitialCondition,
  type OregonatorModel,
} from "@vibloom/chem";
import type { ClaimNode, ModelNode, ResultRecord } from "@vibloom/contracts";

export interface Check {
  model: string;
  recorded?: number;
  recomputed?: number;
  relativeDifference?: number;
}

export interface Verification {
  outcome: { recorded?: string; recomputed?: string };
  periods: Check[];
  agrees: boolean;
  ms: number;
}

// Re-running a simulation must agree within a declared tolerance, not to the
// last bit: engines differ in the last digits of exp and log.
export const REPRODUCTION_TOLERANCE = 1e-6;

export function verify(r: ResultRecord, claim: ClaimNode, m: ModelNode): Verification {
  const t0 = performance.now();
  const { q = NaN, eps = NaN } = m.params;
  const e = evaluatePoint(
    claim.predicate,
    { q, eps },
    r.point ?? {},
    (r.ic ?? claim.predicate.ic) as InitialCondition,
  );
  const periods = (r.measurements ?? []).map((meas): Check => {
    const again = e.runs[meas.model as OregonatorModel]?.period;
    const c: Check = { model: meas.model };
    if (meas.period !== undefined) c.recorded = meas.period;
    if (again !== undefined) c.recomputed = again;
    if (meas.period !== undefined && again !== undefined) {
      c.relativeDifference = Math.abs(again - meas.period) / meas.period;
    }
    return c;
  });
  const outcome: Verification["outcome"] = {};
  if (r.outcome) outcome.recorded = r.outcome;
  if (e.outcome) outcome.recomputed = e.outcome;
  const agrees =
    outcome.recorded === outcome.recomputed &&
    periods.every(
      (p) => p.relativeDifference === undefined || p.relativeDifference < REPRODUCTION_TOLERANCE,
    );
  return { outcome, periods, agrees, ms: performance.now() - t0 };
}

// log10 x over the last part of a run, for the signal plot.
export function signal(
  kind: OregonatorModel,
  claim: ClaimNode,
  m: ModelNode,
  point: Record<string, number>,
  horizon = 40,
): { t: number[]; v: number[] } {
  const { q = NaN, eps = NaN } = m.params;
  const params = { q, eps, s: point.s ?? NaN, eps_prime: point.eps_prime ?? NaN };
  const ic = claim.predicate.ic as InitialCondition;
  const tr = solve(model(kind, params), initialState(kind, params, ic), horizon, {
    rtol: 1e-7,
    atol: 1e-12,
    hmax: 1,
  });
  const s = resample(tr, 0, 1 / 40);
  return { t: s.t, v: s.v.map((x) => Math.log10(Math.max(x, 1e-12))) };
}

// The oxidised catalyst z(t), the variable that turns a real Belousov-
// Zhabotinsky solution from red to blue. Same solver, point and initial
// condition as the recorded run.
export function catalyst(
  kind: OregonatorModel,
  claim: ClaimNode,
  m: ModelNode,
  point: Record<string, number>,
  horizon = 80,
): { t: number[]; z: number[] } {
  const { q = NaN, eps = NaN } = m.params;
  const params = { q, eps, s: point.s ?? NaN, eps_prime: point.eps_prime ?? NaN };
  const ic = claim.predicate.ic as InitialCondition;
  const tr = solve(model(kind, params), initialState(kind, params, ic), horizon, {
    rtol: 1e-7,
    atol: 1e-12,
    hmax: 1,
  });
  const s = resample(tr, kind === "full" ? 2 : 1, 1 / 20);
  return { t: s.t, z: s.v };
}
