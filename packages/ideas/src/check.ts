// Evaluating a check: the model's expressions are parsed by the engine's own
// arithmetic language, and the engine, not the model, decides pass or fail.

import { compare, evaluate } from "./expr";
import type { CheckResult, CheckSpec } from "./types";

export function runCheck(
  spec: CheckSpec,
  scope: Record<string, number>,
): CheckResult | { error: string } {
  const inputs: Record<string, number> = {};
  try {
    const value = evaluate(spec.value, scope, inputs);
    const limit = evaluate(spec.limit, scope, inputs);
    if (!Number.isFinite(value) || !Number.isFinite(limit)) {
      return { error: "the expressions did not give finite numbers" };
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
    return { error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

export interface Threshold {
  name: string;
  current: number;
  // The value at which the comparison flips, holding everything else fixed.
  at?: number;
  // Which side of `at` makes the assumption hold.
  holdsWhen?: "above" | "below";
}

// For each parameter a check read, find where its verdict flips, holding the
// others fixed: the nearest flip on a log grid from 1e-4 to 1e4 times the
// current value, then bisection.
export function thresholds(
  spec: CheckSpec,
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
    const grid = Array.from({ length: 160 }, (_, i) => {
      const step = Math.floor(i / 2) + 1;
      return current * 10 ** ((i % 2 === 0 ? 1 : -1) * step * 0.05);
    });
    const flip = grid.find((v) => {
      const h = holds(name, v);
      return h !== undefined && h !== here;
    });
    if (flip === undefined) return out;
    let lo = current;
    let hi = flip;
    for (let k = 0; k < 60; k++) {
      const mid = Math.sign(lo) * Math.sqrt(lo * hi);
      if (holds(name, mid) === here) lo = mid;
      else hi = mid;
    }
    out.at = hi;
    // Which side holds: compare the side beyond the flip with the verdict there.
    out.holdsWhen = hi > current === !here ? "above" : "below";
    return out;
  });
}
