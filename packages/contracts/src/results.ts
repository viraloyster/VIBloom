// The five state dimensions of a result. They are never merged into one field.

export type ExecutionFailure =
  "budget_exhausted" | "step_too_small" | "singular_system" | "non_finite" | "domain_exit";

export type Execution =
  | { status: "completed" }
  | { status: "cancelled" }
  | { status: "failed"; reason: ExecutionFailure };

export type Observation = "oscillation" | "steady_state" | "indeterminate";

export type PointOutcome = "holds" | "fails" | "inconclusive" | "not_applicable";

// There is deliberately no "holds" status: sampling cannot prove a region claim.
export type RegionStatus =
  | { status: "unexplored" }
  | {
      status: "counterexample_found";
      counterexamples: number;
      evaluated: number;
      inconclusive: number;
    }
  | { status: "no_counterexample"; evaluated: number; inconclusive: number };

// pending_review: an assumption changed. unsupported: one was switched off or refuted.
export type Currency = "current" | "pending_review" | "unsupported";
