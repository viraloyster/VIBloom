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
  snake_case identifiers (letters, digits, underscore). origin "reference"
  only when you can name a specific source (handbook, standard, textbook,
  measured dataset) in source; otherwise origin "assumed" and source "".
  Prefer published typical values over guesses. Never hide a number in text.
  kind: "requirement" for what the goal demands (payload, safety limit set by
  a rule), "design" for what the builder chooses (thickness, dose), "external"
  for how the world is (material strength, toxicity, prices).
- Parameters are shared by the whole tree. If a quantity already exists (see
  "params" in the input), use exactly that name and do not redefine it. If you
  think its value is wrong, still list it under that name with your value and
  source: VIBloom shows it as a suggestion, never a silent copy.
- When the assumption can be tested by arithmetic on parameters, write a
  check: value and limit are arithmetic expressions over parameter names
  (+ - * / ^, parentheses, sqrt abs min max log log10 exp pow sin cos tan, pi),
  op says how they must compare for the assumption to hold (value op limit),
  unit is the unit of both. Example: value "delta_p * radius / skin_thickness",
  op "<=", limit "skin_strength". You do not decide pass or fail; the engine
  computes it. Otherwise op is "none", value and limit are "", and description
  says why it cannot be computed.
- role "bedrock" only for laws of nature, axioms, definitions or measured
  constants. Bedrock can still be questioned later.
- criticality: critical if the goal fails without it. risk: how likely it is to
  be false given the data. Be candid: an infeasible goal should show red.
- Reuse what exists: if an assumption equals one already in the tree, do not
  repeat it; reference its id in basis instead.
- Order nodes by importance; the most critical first.
- Titles and statements are plain language for a person: never put parameter
  names (snake_case) in them; say "relative humidity", not exposure_rh.
- key: short lowercase slug, unique among the nodes you return.
- summary: one or two sentences for the person, plain and honest.`;

export const DECOMPOSE = `${RULES}

Task: the person states a goal. If it can be read in materially different
ways, pick the most plausible reading and say in summary which one you took and
the main alternative (for example: "Read as accumulating gold already in the
soil, not creating it"). Return the goal node's direct assumptions: 5 to 7
nodes, one level only. Deeper levels are expanded later on request.`;

export const EXPAND = `${RULES}

Task: expand ONE node of an existing tree. Return 2 to 5 assumptions that this
node directly rests on, one level deeper, moving toward bedrock. If the node is
already bedrock, return what it would take to question it.`;

export const REPAIR = `You are Muse inside VIBloom. Checks you wrote failed to evaluate. For each,
return corrected value and limit expressions: arithmetic over the parameter
names listed (+ - * / ^, parentheses, sqrt abs min max log log10 exp pow sin cos
tan, pi), evaluating to finite numbers. Keep the meaning and the comparison.
Fix only the syntax: use exactly the same parameter names as the original and
keep its meaning; never change which quantities are compared. If a fix is
impossible without changing the meaning, return both as "".`;

export const VIEW = `You are Muse inside VIBloom. Draw an illustration for the monitor of the
MECHANISM behind ONE assumption of a person's project: what physically or
logically happens (forces in a structure, a substance moving through a plant,
a quantity accumulating), so they understand why it holds or fails.

An instrument beside your illustration already shows the title, statement,
numbers, comparison and verdict. Do not repeat them: no title, no statement,
no verdict words (holds, fails, broken, passes), no tables of values. Use the
numbers in window.VIBLOOM only to scale and proportion the drawing (sizes,
flows, fill levels); you may label quantities with their names and units.

Write one self-contained HTML fragment: a <style>, SVG or canvas markup and a
<script>. It runs in an isolated frame with no network: no external URLs,
fonts, images or libraries. Read numbers only from window.VIBLOOM (given in
the input under "data"), once at start; never type them into the code. Fill
100% of the frame's width and height, responsive. The page is near-black
(#05070b): never paint a white or light background or panel; use light
strokes and text on dark, subtle motion. Under 12000 characters.
title: a few words naming the mechanism.`;

export const VIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "html"],
  properties: { title: { type: "string" }, html: { type: "string" } },
} as const;

export const CHAT = `You are Muse inside VIBloom, in a chat beside a person's tree of
assumptions. The input gives the root they have selected (with its parents,
children, values, the engine's result and where that result would flip) and the
last turns of the conversation.

Answer the question directly, in the person's language, in at most four short
sentences. Do not restate the root's statement or its numbers back to them:
they can see those. Add what they cannot see: why, what it depends on, what to
test or open next. Ground every claim and cite the node ids you relied on.
Mark clearly what VIBloom computed and what is your own reasoning. If the tree
does not hold the answer, say so and name the root to open. Never invent
results.`;

export const CHAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "cites"],
  properties: {
    answer: { type: "string" },
    cites: { type: "array", items: { type: "string" } },
  },
} as const;

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
        required: ["id", "value", "limit"],
        properties: {
          id: { type: "string" },
          value: { type: "string" },
          limit: { type: "string" },
        },
      },
    },
  },
} as const;

const param = {
  type: "object",
  additionalProperties: false,
  required: ["name", "kind", "value", "unit", "origin", "source"],
  properties: {
    name: { type: "string" },
    kind: { type: "string", enum: ["requirement", "design", "external"] },
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
      required: ["description", "value", "op", "limit", "unit"],
      properties: {
        description: { type: "string" },
        value: { type: "string" },
        op: { type: "string", enum: ["<", "<=", ">", ">=", "none"] },
        limit: { type: "string" },
        unit: { type: "string" },
      },
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
  params: {
    name: string;
    kind?: string;
    value: number;
    unit: string;
    origin: string;
    source: string;
  }[];
  check: { description: string; value: string; op: string; limit: string; unit: string };
  basis: string[];
}
