// The concentrations over a few periods, for drawing: the same models,
// solver tolerances and initial condition as the experiment, sampled evenly
// after the start has settled.

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
  const end = settle + periods * period;
  const tr = solve(model(kind, params), initialState(kind, params, "far"), end, {
    rtol: PROTOCOL.rtol,
    atol: PROTOCOL.atol,
    hmax: PROTOCOL.hmax,
  });
  if (tr.execution.status !== "completed") return undefined;
  const dt = (periods * period) / points;
  const xs = resample(tr, 0, dt);
  const zs = resample(tr, kind === "full" ? 2 : 1, dt);
  const from = xs.t.findIndex((t) => t >= settle);
  if (from < 0) return undefined;
  return {
    t: xs.t.slice(from).map((t) => t - settle),
    x: xs.v.slice(from),
    z: zs.v.slice(from),
  };
}
