// The decomposition protocol: the same axes, the same rules and the same output
// shape for every person, so two people asking for the same thing get trees
// that differ as little as the data allows.

export const AXES = [
  "requirements",
  "principles",
  "materials",
  "loads",
  "economics",
  "constraints",
  "risks",
  "definitions",
  "cases",
  "methods",
] as const;

const RULES = `You are Muse inside VIBloom, an engine that decomposes any goal into the
assumptions it rests on, down to first principles, so each one can be tested.

Protocol (follow it exactly; it keeps trees comparable between people):
- Pick axes only from: ${AXES.join(", ")}. Physical goals usually use
  requirements, principles, materials, loads, economics, constraints, risks.
  Mathematical or abstract goals use definitions, principles, cases, methods.
- Each node states ONE assumption that could be false, as a plain sentence
  ("Corrugated cardboard spars carry the 2.5 g limit load"), not a topic.
- Put every number you rely on in params with its unit. Param names are
  snake_case identifiers (letters, digits, underscore) and are referenced in
  check code as p.name. origin "reference"
  only when you can name a specific source (handbook, standard, textbook,
  measured dataset) in source; otherwise origin "assumed" and source "".
  Prefer published typical values over guesses. Never hide a number in text.
- When the assumption can be tested by arithmetic on params in scope (this
  node, its ancestors, or nodes listed in basis), write check.code: the body of
  a JavaScript function of one argument p (params by name) that returns
  { value, limit, unit, pass, detail }. Pure arithmetic, no loops over 10000
  steps, no I/O. Otherwise check.code is "" and check.description says why.
- role "bedrock" only for laws of nature, axioms, definitions or measured
  constants. Bedrock can still be questioned later.
- criticality: critical if the goal fails without it. risk: how likely it is to
  be false given the data. Be candid: an infeasible goal should show red.
- Reuse what exists: if an assumption equals one already in the tree, do not
  repeat it; reference its id in basis instead.
- Order nodes by importance; the most critical first.
- key: short lowercase slug, unique among the nodes you return.
- summary: one or two sentences for the person, plain and honest.`;

export const DECOMPOSE = `${RULES}

Task: the person states a goal. Return the goal node's direct assumptions: 5 to
7 nodes, one level only. Deeper levels are expanded later on request.`;

export const EXPAND = `${RULES}

Task: expand ONE node of an existing tree. Return 2 to 5 assumptions that this
node directly rests on, one level deeper, moving toward bedrock. If the node is
already bedrock, return what it would take to question it.`;

export const REPAIR = `You are Muse inside VIBloom. Calculations you wrote failed to run. For each,
return corrected code: the body of a JavaScript function of one argument p
(the parameters listed, by name) that returns { value, limit, unit, pass,
detail } with finite numbers and a boolean pass. Pure arithmetic, no I/O. Use
only the parameter names given. If a fix is impossible, return code "".`;

export const REPAIR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fixes"],
  properties: {
    fixes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "code"],
        properties: { id: { type: "string" }, code: { type: "string" } },
      },
    },
  },
} as const;

const param = {
  type: "object",
  additionalProperties: false,
  required: ["name", "value", "unit", "origin", "source"],
  properties: {
    name: { type: "string" },
    value: { type: "number" },
    unit: { type: "string" },
    origin: { type: "string", enum: ["reference", "assumed"] },
    source: { type: "string" },
  },
} as const;

const node = {
  type: "object",
  additionalProperties: false,
  required: [
    "key",
    "title",
    "statement",
    "axis",
    "role",
    "criticality",
    "risk",
    "rationale",
    "params",
    "check",
    "basis",
  ],
  properties: {
    key: { type: "string" },
    title: { type: "string" },
    statement: { type: "string" },
    axis: { type: "string", enum: [...AXES] },
    role: { type: "string", enum: ["assumption", "bedrock"] },
    criticality: { type: "string", enum: ["critical", "major", "minor"] },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    rationale: { type: "string" },
    params: { type: "array", items: param },
    check: {
      type: "object",
      additionalProperties: false,
      required: ["description", "code"],
      properties: { description: { type: "string" }, code: { type: "string" } },
    },
    basis: { type: "array", items: { type: "string" } },
  },
} as const;

export const GROWTH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "nodes"],
  properties: {
    summary: { type: "string" },
    nodes: { type: "array", items: node },
  },
} as const;

export interface GrownNode {
  key: string;
  title: string;
  statement: string;
  axis: string;
  role: "assumption" | "bedrock";
  criticality: "critical" | "major" | "minor";
  risk: "low" | "medium" | "high";
  rationale: string;
  params: { name: string; value: number; unit: string; origin: string; source: string }[];
  check: { description: string; code: string };
  basis: string[];
}
