// Oscillation detection and the robust classification protocol
// (docs/science.md, docs/validation.md).

import type { Execution, Observation } from "@vibloom/contracts";
import {
  initialState,
  model,
  steadyStateX,
  type InitialCondition,
  type OregonatorModel,
  type OregonatorParams,
} from "./oregonator";
import { resample, solve, type SolveStats } from "./solver";

export const DETECTION = {
  minSwingDecades: 1,
  minPeaks: 4,
  maxPeriodCV: 0.05,
  peakProminenceDecades: 0.5,
  maxSteadySwingDecades: 0.1,
  maxSteadyOffset: 0.05,
  sampleStep: 1 / 40,
} as const;

export const PROTOCOL = {
  rtol: 1e-7,
  tightRtol: 1e-9,
  atol: 1e-12,
  hmax: 1,
  initialHorizon: 150,
  // Limits the base run; the validation run uses twice the base horizon.
  maxBaseHorizon: 6000,
  maxPeriodSpread: 5e-3,
} as const;

export type Reading =
  | { kind: "oscillation"; period: number }
  | { kind: "steady_state" }
  | { kind: "irregular" }
  | { kind: "need_longer"; periodEstimate?: number };

// Peaks with a minimum prominence, as in scipy.signal.find_peaks.
export function peaks(v: readonly number[], minProminence: number): number[] {
  const out: number[] = [];
  for (let i = 1; i < v.length - 1; i++) {
    const vi = v[i]!;
    if (!(vi > v[i - 1]! && vi >= v[i + 1]!)) continue;
    let left = vi;
    for (let j = i - 1; j >= 0 && v[j]! <= vi; j--) left = Math.min(left, v[j]!);
    let right = vi;
    for (let j = i + 1; j < v.length && v[j]! <= vi; j++) right = Math.min(right, v[j]!);
    if (vi - Math.max(left, right) >= minProminence) out.push(i);
  }
  return out;
}

// A loop, not Math.max(...v): long horizons exceed the engine's argument limit.
function spread(v: readonly number[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of v) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return hi - lo;
}

// Sub-sample peak position from the parabola through three samples, in samples.
function vertexOffset(a: number, b: number, c: number): number {
  const curvature = a - 2 * b + c;
  return curvature < 0 ? (0.5 * (a - c)) / curvature : 0;
}

// Reads the second half of a uniformly sampled x(t).
export function read(t: readonly number[], x: readonly number[], xSteady: number): Reading {
  const end = t[t.length - 1] ?? 0;
  const start = t.findIndex((s) => s >= end / 2);
  const window = t.slice(start);
  const logx = x.slice(start).map((v) => Math.log10(v));
  const swing = spread(logx);
  const dt = (window[1] ?? 0) - (window[0] ?? 0);
  const times = peaks(logx, DETECTION.peakProminenceDecades).map(
    (i) => window[i]! + dt * vertexOffset(logx[i - 1]!, logx[i]!, logx[i + 1]!),
  );

  if (swing > DETECTION.minSwingDecades && times.length >= DETECTION.minPeaks) {
    const gaps = times.slice(1).map((v, i) => v - times[i]!);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
    return sd / mean < DETECTION.maxPeriodCV
      ? { kind: "oscillation", period: mean }
      : { kind: "irregular" };
  }
  if (swing > DETECTION.minSwingDecades) {
    const first = times[0];
    const last = times[times.length - 1];
    return times.length >= 2 && first !== undefined && last !== undefined
      ? { kind: "need_longer", periodEstimate: (last - first) / (times.length - 1) }
      : { kind: "need_longer" };
  }
  const xEnd = x[x.length - 1] ?? NaN;
  if (
    swing < DETECTION.maxSteadySwingDecades &&
    Math.abs(xEnd - xSteady) / xSteady < DETECTION.maxSteadyOffset
  ) {
    return { kind: "steady_state" };
  }
  return { kind: "need_longer" };
}

export interface Run {
  horizon: number;
  rtol: number;
  execution: Execution;
  reading: Reading | null;
  stats: SolveStats;
}

export interface ModelPoint {
  model: OregonatorModel;
  params: OregonatorParams;
  ic: InitialCondition;
}

export function runOnce(point: ModelPoint, horizon: number, rtol: number): Run {
  const sys = model(point.model, point.params);
  const y0 = initialState(point.model, point.params, point.ic);
  const tr = solve(sys, y0, horizon, { rtol, atol: PROTOCOL.atol, hmax: PROTOCOL.hmax });
  if (tr.execution.status !== "completed") {
    return { horizon, rtol, execution: tr.execution, reading: null, stats: tr.stats };
  }
  const s = resample(tr, 0, DETECTION.sampleStep);
  return {
    horizon,
    rtol,
    execution: tr.execution,
    reading: read(s.t, s.v, steadyStateX(point.params)),
    stats: tr.stats,
  };
}

export interface Classification {
  execution: Execution;
  observation: Observation;
  period?: number;
  horizon: number;
  runs: Run[];
}

function nextHorizon(h: number, r: Reading | null) {
  const estimate = r?.kind === "need_longer" ? (r.periodEstimate ?? 0) : 0;
  return Math.min(Math.max(4 * h, 12 * estimate), PROTOCOL.maxBaseHorizon);
}

function agree(a: Reading, b: Reading) {
  if (a.kind !== b.kind) return false;
  if (a.kind !== "oscillation" || b.kind !== "oscillation") return true;
  return Math.abs(a.period - b.period) / b.period <= PROTOCOL.maxPeriodSpread;
}

// A point is classified only when the base run, a run with tighter tolerances
// and a run with twice the horizon agree. Anything else is indeterminate.
export function classify(point: ModelPoint): Classification {
  const runs: Run[] = [];
  const done = (
    observation: Observation,
    horizon: number,
    execution: Execution = { status: "completed" },
    period?: number,
  ): Classification =>
    period === undefined
      ? { execution, observation, horizon, runs }
      : { execution, observation, period, horizon, runs };

  let horizon: number = PROTOCOL.initialHorizon;
  let base: Run;
  for (;;) {
    base = runOnce(point, horizon, PROTOCOL.rtol);
    runs.push(base);
    if (base.execution.status !== "completed")
      return done("indeterminate", horizon, base.execution);
    if (base.reading?.kind !== "need_longer") break;
    if (horizon >= PROTOCOL.maxBaseHorizon) return done("indeterminate", horizon);
    horizon = nextHorizon(horizon, base.reading);
  }

  const tight = runOnce(point, horizon, PROTOCOL.tightRtol);
  const longer = runOnce(point, 2 * horizon, PROTOCOL.rtol);
  runs.push(tight, longer);
  for (const r of [tight, longer]) {
    if (r.execution.status !== "completed") return done("indeterminate", horizon, r.execution);
  }

  const [a, b, c] = [base.reading, tight.reading, longer.reading];
  if (!a || !b || !c || !agree(a, b) || !agree(a, c)) return done("indeterminate", horizon);
  if (b.kind === "oscillation") return done("oscillation", horizon, undefined, b.period);
  if (b.kind === "steady_state") return done("steady_state", horizon);
  return done("indeterminate", horizon);
}
