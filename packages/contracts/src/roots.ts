// The roots map: what every conclusion rests on. Six node kinds; results and
// citations are immutable records referenced from nodes and edges.

import type { Claim as Predicate } from "./claims";
import type { Currency, Execution, Observation, PointOutcome, RegionStatus } from "./results";

export type NodeKind = "assumption" | "invariant" | "source" | "model" | "experiment" | "claim";

interface NodeBase {
  id: string;
  // Increases on every accepted change; evidence pins the revisions it used.
  revision: number;
  title: string;
}

export interface AssumptionNode extends NodeBase {
  kind: "assumption";
  statement: string;
  scope: string;
  state: "adopted" | "hypothetical" | "off";
  protected: boolean;
}

// A mandatory check implemented in code. Models cannot relax or remove one.
export interface InvariantNode extends NodeBase {
  kind: "invariant";
  check: string;
  version: string;
  scope: string;
}

export interface SourceNode extends NodeBase {
  kind: "source";
  reference: string;
  version: string;
  sha256: string;
}

export interface ModelNode extends NodeBase {
  kind: "model";
  name: string;
  version: string;
  equations: string;
  params: Record<string, number>;
  scaling: string;
  mapping?: string;
}

export interface ExperimentSpec {
  model: Pin;
  claim: Pin;
  solver: string;
  detector: string;
  protocol: string;
  seed?: number;
}

export interface ExperimentNode extends NodeBase {
  kind: "experiment";
  spec: ExperimentSpec;
  results: string[];
}

export interface ClaimNode extends NodeBase {
  kind: "claim";
  version: number;
  text: string;
  predicate: Predicate;
  protocol: string;
  supersedes?: Pin;
}

export type RootNode =
  AssumptionNode | InvariantNode | SourceNode | ModelNode | ExperimentNode | ClaimNode;

// A node at an exact revision.
export interface Pin {
  id: string;
  revision: number;
}

// A fragment of a source: what was read, where, and what it needs to be read right.
export interface Citation {
  source: Pin;
  locator: string;
  quote: string;
  context?: string;
}

// "from depends_on to": from needs to. Invalidation walks the edges backwards.
// Edges derived from an experiment spec are always confirmed.
export interface DependsOn {
  from: string;
  to: string;
  origin: "spec" | "human" | "model";
  state: "confirmed" | "hypothetical";
  citation?: Citation;
}

// Immutable output of one experiment run. An execution that breaks an
// invariant is a failed run with diagnostics, not a refutation.
export interface ResultRecord {
  id: string;
  experiment: Pin;
  claim: Pin;
  assumptions: Pin[];
  // Revisions of the whole dependency closure, captured by code when the run
  // was prepared. Never rebuilt later from the current graph.
  basis: Pin[];
  execution: Execution;
  observation?: Observation;
  // The effective point (claim fixed values included) and initial condition.
  point?: Record<string, number>;
  ic?: string;
  // What each model showed, so explanations can cite numbers, not prose.
  measurements?: Measurement[];
  comparison?: PeriodComparison;
  outcome?: PointOutcome;
  region?: RegionStatus;
  violated?: { invariant: Pin; detail: string };
}

export interface Measurement {
  model: string;
  execution: Execution;
  observation: Observation;
  period?: number;
  // Base horizon reached by the robust protocol, and runs it took.
  horizon: number;
  runs: number;
}

// relativeError = (reference - reduced) / reduced, defined only when both oscillate.
export interface PeriodComparison {
  reference: string;
  reduced: string;
  relativeError: number;
  tolerance: number;
}

// Evidence links a concrete result to an exact claim version. Code derives
// numerical evidence; model proposals stay review signals and never set status.
export interface Evidence {
  relation: "supports" | "refutes";
  result: string;
  claim: Pin;
  origin: "code" | "model";
  currency: Currency;
}
