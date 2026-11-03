// An idea tree: any goal decomposed into the assumptions it rests on, down to
// first principles. Domain-agnostic; chemistry plugs in deeper checks later.

export type Role = "goal" | "assumption" | "bedrock";
export type Criticality = "critical" | "major" | "minor";
export type Risk = "low" | "medium" | "high";

// Where a number comes from. "reference" means the model named a source it
// did not verify; only a person can mark a value as checked.
export type Origin = "reference" | "assumed";

export interface Param {
  name: string;
  value: number;
  unit: string;
  origin: Origin;
  source: string;
}

// Arithmetic the model wrote to test the assumption from the parameters in
// scope. Runs isolated, with no I/O.
export interface CheckSpec {
  description: string;
  code: string;
}

export interface CheckResult {
  pass: boolean;
  value: number;
  limit: number;
  unit: string;
  detail: string;
  // Parameters the check read, as they were when it ran.
  inputs: Record<string, number>;
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
  params: Param[];
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
  | { type: "goal"; text: string; mode: Mode }
  | { type: "grow"; under: string; nodes: IdeaNode[]; summary: string; usage: Usage }
  | { type: "check"; node: string; result: CheckResult | { error: string } }
  | { type: "repair"; fixes: { node: string; code: string }[]; usage: Usage }
  | { type: "set_param"; node: string; name: string; value: number }
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
