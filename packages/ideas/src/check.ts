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
