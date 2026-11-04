// Evaluating a check: the model's expressions are parsed by the engine's own
// arithmetic language, and the engine, not the model, decides pass or fail.

import { evaluatePoint, fromRecipe, RECIPE_VERSION, SOLVER_VERSION } from "@vibloom/chem";
import type { Claim } from "@vibloom/contracts";
import { compare, evaluate } from "./expr";
import type { ArithmeticSpec, CheckError, CheckResult, CheckSpec, SimulationSpec } from "./types";

export const SIM_PARAMS = ["s", "q", "eps", "eps_prime"] as const;

export function runCheck(spec: CheckSpec, scope: Record<string, number>): CheckResult | CheckError {
  return spec.kind === "oregonator" ? simulate(spec, scope) : arithmetic(spec, scope);
}

// The chemistry engine's own protocol (stiff solver, robust classification)
// decides; the model chose only which question to ask.
function simulate(spec: SimulationSpec, scope: Record<string, number>): CheckResult | CheckError {
  const inputs: Record<string, number> = {};
  for (const k of SIM_PARAMS) {
    const v = scope[k];
    if (v !== undefined) inputs[k] = v;
    if (v === undefined || !Number.isFinite(v) || v <= 0)
      return { error: `the experiment needs a positive ${k}`, inputs };
  }
  // A recipe's time scale travels with the run, so its period in seconds is
  // part of what was recorded.
  if (scope.time_scale_s !== undefined) inputs.time_scale_s = scope.time_scale_s;
  if (scope.recipe_version !== undefined) inputs.recipe_version = scope.recipe_version;
  const point = { s: inputs.s ?? NaN, eps_prime: inputs.eps_prime ?? NaN };
  const claim: Claim =
    spec.question === "reduction_keeps_period"
      ? {
          kind: "PERIOD_WITHIN",
          reference: "full",
          reduced: "reduced",
          point,
          ic: "far",
          tolerance: spec.tolerance,
        }
      : {
          kind: "OSCILLATES",
          model: spec.question === "oscillates" ? "full" : "reduced",
          point,
          ic: "far",
        };
  try {
    const e = evaluatePoint(claim, { q: inputs.q ?? NaN, eps: inputs.eps ?? NaN }, point, "far");
    if (e.execution.status !== "completed")
      return { error: `the solver stopped: ${e.execution.status}`, inputs };
    if (e.outcome !== "holds" && e.outcome !== "fails") {
      return {
        error: `the experiment was ${e.outcome ?? "inconclusive"}; nothing is concluded`,
        inputs,
      };
    }
    const full = e.runs.full;
    const reduced = e.runs.reduced;
    const rel =
      full?.period !== undefined && reduced?.period !== undefined
        ? Math.abs(full.period - reduced.period) / reduced.period
        : 0;
    return {
      pass: e.outcome === "holds",
      value: rel,
      limit: spec.question === "reduction_keeps_period" ? spec.tolerance : 0,
      op: "<=",
      unit: "",
      inputs,
      engine: SOLVER_VERSION,
      sim: {
        outcome: e.outcome,
        periods: {
          ...(full?.period !== undefined ? { full: full.period } : {}),
          ...(reduced?.period !== undefined ? { reduced: reduced.period } : {}),
        },
        observations: {
          ...(full ? { full: full.observation } : {}),
          ...(reduced ? { reduced: reduced.observation } : {}),
        },
      },
    };
  } catch (err) {
    return { error: (err instanceof Error ? err.message : String(err)).slice(0, 200), inputs };
  }
}

function arithmetic(spec: ArithmeticSpec, scope: Record<string, number>): CheckResult | CheckError {
  const inputs: Record<string, number> = {};
  try {
    const value = evaluate(spec.value, scope, inputs);
    const limit = evaluate(spec.limit, scope, inputs);
    if (!Number.isFinite(value) || !Number.isFinite(limit)) {
      return { error: "the expressions did not give finite numbers", inputs };
    }
    return {
      pass: compare(value, spec.op, limit),
      value,
      limit,
      op: spec.op,
      unit: spec.unit,
      inputs,
    };
  } catch (e) {
    return { error: (e instanceof Error ? e.message : String(e)).slice(0, 200), inputs };
  }
}

export interface Threshold {
  name: string;
  current: number;
  // The nearest value at which the verdict flips, holding everything else
  // fixed, within 1e-4 to 1e4 times the current value. A local finding, not a
  // global law.
  at?: number;
  // Which side of `at` makes the assumption hold.
  holdsWhen?: "above" | "below";
  // False when the verdict flips back further out, so no single threshold
  // describes it.
  single?: boolean;
}

export function thresholds(
  spec: ArithmeticSpec,
  scope: Record<string, number>,
  names: string[],
): Threshold[] {
  const holds = (name: string, v: number) => {
    const r = runCheck(spec, { ...scope, [name]: v });
    return "error" in r ? undefined : r.pass;
  };
  return names.map((name) => {
    const current = scope[name] ?? NaN;
    const out: Threshold = { name, current };
    const here = holds(name, current);
    if (!Number.isFinite(current) || current === 0 || here === undefined) return out;
    // Nearest first: alternate above and below on a log grid.
    const grid = Array.from({ length: 160 }, (_, i) => {
      const step = Math.floor(i / 2) + 1;
      return current * 10 ** ((i % 2 === 0 ? 1 : -1) * step * 0.05);
    });
    let flip: number | undefined;
    for (const v of grid) {
      const h = holds(name, v);
      // An undefined point (a singularity) ends the search: no honest threshold.
      if (h === undefined) return out;
      if (h !== here) {
        flip = v;
        break;
      }
    }
    if (flip === undefined) return out;
    let lo = current;
    let hi = flip;
    for (let k = 0; k < 60; k++) {
      const mid = Math.sign(lo) * Math.sqrt(lo * hi);
      const h = holds(name, mid);
      if (h === undefined) return out;
      if (h === here) lo = mid;
      else hi = mid;
    }
    out.at = hi;
    const up = hi > current;
    out.holdsWhen = up === !here ? "above" : "below";
    // Walk on past the flip: if the verdict changes again, say so.
    const beyond = Array.from({ length: 20 }, (_, i) => hi * 10 ** ((up ? 1 : -1) * (i + 1) * 0.2));
    out.single = beyond.every((v) => holds(name, v) === !here);
    return out;
  });
}

export const RECIPE_PARAMS = ["bromate", "malonic_acid", "acid"] as const;

// q, eps, eps_prime and time_scale_s from a recipe in the tree, for those of
// them no node sets itself. Nothing if the recipe is absent or impossible.
export function recipeDerived(values: Record<string, number>): Record<string, number> {
  const [bromate, malonic_acid, acid] = RECIPE_PARAMS.map((k) => values[k]);
  if (bromate === undefined || malonic_acid === undefined || acid === undefined) return {};
  try {
    const all = fromRecipe({ bromate, malonic_acid, acid }) as unknown as Record<string, number>;
    return {
      ...Object.fromEntries(Object.entries(all).filter(([k]) => values[k] === undefined)),
      recipe_version: RECIPE_VERSION,
    };
  } catch {
    return {};
  }
}
