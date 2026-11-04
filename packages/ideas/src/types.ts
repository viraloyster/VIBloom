// An idea tree: any goal decomposed into the assumptions it rests on, down to
// first principles. Domain-agnostic; chemistry plugs in deeper checks later.

export type Role = "goal" | "assumption" | "bedrock";
export type Criticality = "critical" | "major" | "minor";
export type Risk = "low" | "medium" | "high";

// Where a number comes from. "reference" means the model named a source it
// did not verify; only a person can mark a value as checked.
export type Origin = "reference" | "assumed";

// What editing a value means: a requirement changes the goal, a design
// variable changes the plan, an external property is how the world is, so
// changing it only builds a hypothetical scenario.
export type ParamKind = "requirement" | "design" | "external";

export interface Param {
  name: string;
  kind: ParamKind;
  value: number;
  unit: string;
  origin: Origin;
  source: string;
}

// The assumption holds when value op limit. The model writes the two
// expressions and the comparison; the engine evaluates and decides.
export interface ArithmeticSpec {
  kind?: "arithmetic";
  description: string;
  value: string;
  op: "<" | "<=" | ">" | ">=";
  limit: string;
  unit: string;
  // Parameters that state the result the node claims (an "achieved" or
  // "demonstrated" number). If one is merely assumed, the check is conditional.
  observes?: string[];
}

// A real experiment: the Oregonator model of the Belousov-Zhabotinsky
// reaction, run by the chemistry engine at the tree's values of s, q, eps and
// eps_prime. The model only chooses the question.
export type SimQuestion = "oscillates" | "reduced_oscillates" | "reduction_keeps_period";

export interface SimulationSpec {
  kind: "oregonator";
  description: string;
  question: SimQuestion;
  // Largest relative period difference the reduction may show.
  tolerance: number;
  op: "<=";
  unit: "";
}

export type CheckSpec = ArithmeticSpec | SimulationSpec;

export interface CheckResult {
  pass: boolean;
  value: number;
  limit: number;
  op: CheckSpec["op"];
  unit: string;
  // Parameters the check read, as they were when it ran.
  inputs: Record<string, number>;
  // For an experiment: what each model did.
  sim?: {
    outcome: string;
    periods: { full?: number; reduced?: number };
    observations: { full?: string; reduced?: string };
  };
}

// A check that could not be evaluated keeps the values it was given, so a
// later change to them retries it.
export interface CheckError {
  error: string;
  inputs?: Record<string, number>;
}

export interface IdeaNode {
  id: string;
  parent: string | null;
  title: string;
  statement: string;
  axis: string;
  role: Role;
  criticality: Criticality;
  risk: Risk;
  rationale: string;
  // Parameters this node introduced. Names are unique across the tree.
  params: Param[];
  // Existing parameters this node relies on or explains.
  uses: string[];
  // Values the model proposed for existing parameters; a person decides.
  suggestions: Param[];
  check?: CheckSpec;
  // Other nodes this one rests on, beyond its own children.
  basis: string[];
  // Large changes the model may only suggest.
  proposed: boolean;
  expanded: boolean;
}

export interface Usage {
  model: string;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  cost: number;
}

export type EventBody =
  // sketch: the handwriting Muse read the goal from, if it was written by hand.
  | { type: "goal"; text: string; mode: Mode; sketch?: string }
  | { type: "grow"; under: string; nodes: IdeaNode[]; summary: string; usage: Usage }
  | { type: "check"; node: string; result: CheckResult | CheckError }
  | { type: "repair"; fixes: { node: string; value: string; limit: string }[]; usage: Usage }
  | { type: "set_param"; name: string; value: number; source: string }
  | { type: "view"; node: string; title: string; html: string; usage: Usage }
  | {
      type: "chat";
      focus: string;
      question: string;
      answer: string;
      cites: string[];
      // Every value as it was when Muse answered, so a later edit marks the
      // answer as about other numbers.
      asked: Record<string, number>;
      usage: Usage;
    }
  | {
      type: "predict";
      id: string;
      node: string;
      // The values the prediction was made for: the tree's current ones.
      inputs: Record<string, number>;
      expect: Outcome;
      confidence: number;
      reason: string;
      // Lessons the model says it used.
      uses: string[];
      usage: Usage;
    }
  | {
      // Registered before the discriminating run, so the run cannot shape them.
      type: "hypotheses";
      id: string;
      // The prediction the first run contradicted.
      prediction: string;
      candidates: Candidate[];
      // One run that tells the candidates apart: the same values with one changed.
      test: { param: string; value: number };
      // What this single contrast cannot establish.
      open: string;
      usage: Usage;
    }
  | { type: "test"; hypotheses: string; result: CheckResult | CheckError }
  | {
      // Muse looked at a picture of its own drawing and compared it with the
      // data the drawing was given.
      type: "review";
      node: string;
      ok: boolean;
      problems: string[];
      usage: Usage;
    }
  | {
      // A formula a person wrote by hand, as Muse read it; the engine decides
      // whether it can be computed with the tree's names.
      type: "formula";
      node: string;
      reading: string;
      // The handwriting itself, small, so a replay shows what was read.
      image?: string;
      check: { value: string; op: string; limit: string; unit: string };
      usage: Usage;
    }
  | { type: "accept"; node: string }
  | { type: "reject"; node: string };

export interface IdeaEvent {
  seq: number;
  prev: string;
  hash: string;
  actor: string;
  body: EventBody;
}

// Standard keeps content out of Meta's training; contributor is cheaper and
// lets Meta train on it. A person chooses.
export type Mode = "standard" | "contributor";

export type Outcome = "holds" | "fails";

export interface Candidate {
  explanation: string;
  scope: string;
  expect: Outcome;
}

// One experiment run as recorded in the log. A run read from a log counts
// once this browser has run it again with the same inputs (confirm).
export interface Run {
  seq: number;
  node: string;
  // A check run decides the node; a test run only decides a lesson.
  purpose: "check" | "test";
  result: CheckResult | CheckError;
  state: "unconfirmed" | "confirmed" | "failed";
}

// A surprise, the explanations registered for it and, once run, the test
// that decides between them. Every link is a log reference, checked on apply.
export interface Lesson {
  id: string;
  node: string;
  prediction: string;
  // Sequence number of the run that contradicted the prediction.
  surprise: number;
  basis: Record<string, number>;
  observed: Outcome;
  candidates: Candidate[];
  test: { param: string; value: number };
  open: string;
  // Sequence number of the discriminating run, once recorded.
  run?: number;
  // Numbers in Muse's text that were not in the data it was given.
  unsupported: string[];
}

export interface Prediction {
  id: string;
  node: string;
  inputs: Record<string, number>;
  expect: Outcome;
  confidence: number;
  reason: string;
  uses: string[];
  // The first run of exactly these values after the prediction; permanent.
  run?: number;
  unsupported: string[];
}
