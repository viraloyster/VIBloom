// Point evaluation of a claim. The outcome says what the protocol observed;
// an invalid execution never becomes a refutation.

import type { Claim, Execution, PointOutcome } from "@vibloom/contracts";
import { classify, type Classification } from "./classify";
import type { InitialCondition, OregonatorModel, OregonatorParams } from "./oregonator";

export interface PointEvaluation {
  execution: Execution;
  outcome?: PointOutcome;
  runs: Partial<Record<OregonatorModel, Classification>>;
}

type Body =
  | { kind: "OSCILLATES"; model: string }
  | { kind: "AGREE_ON_OSCILLATION"; reference: string; reduced: string }
  | { kind: "PERIOD_WITHIN"; reference: string; reduced: string; tolerance: number }
  | { kind: "AGREE_AND_PERIOD_WITHIN"; reference: string; reduced: string; tolerance: number };

function body(claim: Claim): Body {
  return claim.kind === "FOR_ALL" ? claim.body : claim;
}

const asModel = (m: string): OregonatorModel => {
  if (m !== "full" && m !== "reduced") throw new RangeError(`unknown model ${m}`);
  return m;
};

// fixed holds the parameters the claim does not set (q, eps); point overrides them.
export function evaluatePoint(
  claim: Claim,
  fixed: Omit<OregonatorParams, "s" | "eps_prime"> & Partial<OregonatorParams>,
  point: Record<string, number>,
  ic: InitialCondition,
): PointEvaluation {
  const b = body(claim);
  const params = { ...fixed, ...point } as OregonatorParams;
  if (!Number.isFinite(params.s) || !Number.isFinite(params.eps_prime)) {
    throw new RangeError("the point must set s and eps_prime");
  }
  const models =
    b.kind === "OSCILLATES" ? [asModel(b.model)] : [asModel(b.reference), asModel(b.reduced)];
  const runs: PointEvaluation["runs"] = {};
  for (const m of models) {
    const c = classify({ model: m, params, ic });
    runs[m] = c;
    if (c.execution.status !== "completed") return { execution: c.execution, runs };
  }

  const [a, r] = models.map((m) => runs[m]!);
  const unknown = (c: Classification) => c.observation === "indeterminate";
  const done = (outcome: PointOutcome): PointEvaluation => ({
    execution: { status: "completed" },
    outcome,
    runs,
  });

  if (b.kind === "OSCILLATES") {
    if (unknown(a!)) return done("inconclusive");
    return done(a!.observation === "oscillation" ? "holds" : "fails");
  }
  if (unknown(a!) || unknown(r!)) return done("inconclusive");
  const bothOscillate = a!.observation === "oscillation" && r!.observation === "oscillation";
  const periodsAgree = (tol: number) =>
    Math.abs(a!.period! - r!.period!) / r!.period! <= tol ? "holds" : "fails";

  switch (b.kind) {
    case "AGREE_ON_OSCILLATION":
      return done(a!.observation === r!.observation ? "holds" : "fails");
    case "PERIOD_WITHIN":
      return done(bothOscillate ? periodsAgree(b.tolerance) : "not_applicable");
    case "AGREE_AND_PERIOD_WITHIN":
      if (a!.observation !== r!.observation) return done("fails");
      return done(bothOscillate ? periodsAgree(b.tolerance) : "holds");
  }
}
