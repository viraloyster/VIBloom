// The concentrations over a few periods, for drawing: the same models,
// solver tolerances and initial condition as the experiment, sampled evenly
// after the start has settled. Each trace starts at a maximum of HBrO2, so
// two models are compared from the same phase, not from arbitrary clocks.

import { PROTOCOL } from "./classify";
import { initialState, model, type OregonatorModel, type OregonatorParams } from "./oregonator";
import { resample, solve } from "./solver";

export interface Trace {
  // Model time, from the first sample shown.
  t: number[];
  // Scaled HBrO2 (x) and oxidised catalyst (z).
  x: number[];
  z: number[];
}

export function trace(
  kind: OregonatorModel,
  params: OregonatorParams,
  period: number,
  periods = 3,
  points = 600,
): Trace | undefined {
  if (!(period > 0)) return undefined;
  // Long enough to settle as in the experiment, then the periods shown.
  const settle = Math.max(10 * period, 50);
  const end = settle + (periods + 1) * period;
  const tr = solve(model(kind, params), initialState(kind, params, "far"), end, {
    rtol: PROTOCOL.rtol,
    atol: PROTOCOL.atol,
    hmax: PROTOCOL.hmax,
  });
  if (tr.execution.status !== "completed") return undefined;
  const dt = (periods * period) / points;
  const xs = resample(tr, 0, dt);
  const zs = resample(tr, kind === "full" ? 2 : 1, dt);
  const start = xs.t.findIndex((t) => t >= settle);
  if (start < 0) return undefined;
  // The largest x within the next period: a maximum of the cycle.
  const span = Math.ceil(period / dt);
  let from = start;
  for (let i = start; i < Math.min(xs.v.length, start + span); i++) {
    if ((xs.v[i] ?? -Infinity) > (xs.v[from] ?? -Infinity)) from = i;
  }
  const to = Math.min(xs.v.length, from + points + 1);
  const t0 = xs.t[from] ?? 0;
  return {
    t: xs.t.slice(from, to).map((t) => t - t0),
    x: xs.v.slice(from, to),
    z: zs.v.slice(from, to),
  };
}
