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
