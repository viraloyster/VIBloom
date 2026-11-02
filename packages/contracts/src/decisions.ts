// What the investigating model may decide on each turn. Every decision is
// structured, cites what it relies on, and is validated before it acts.

import type { Pin } from "./roots";
import {
  any,
  check,
  fail,
  isObj,
  list,
  numbers,
  oneOf,
  pin,
  shape,
  str,
  text,
  type Check,
} from "./schema";

export interface Prediction {
  outcome: "holds" | "fails";
  because: string;
}

export interface ProposedClaim {
  id: string;
  title: string;
  text: string;
  predicate: unknown;
}

export interface ProposedAssumption {
  id: string;
  title: string;
  statement: string;
  scope: string;
}

export interface ProposedDependency {
  from: string;
  to: string;
  reason: string;
}

interface Base {
  rationale: string;
  // Node and result ids the decision relies on.
  cites: string[];
  // Required right after a prediction failed: what the surprise means.
  surprise?: string;
  // Asks for more reasoning effort on the next turn, with the reason.
  escalate?: string;
}

export type Decision = Base &
  (
    | {
        action: "formulate";
        question: string;
        ambiguities: string[];
        claims: ProposedClaim[];
        assumptions: ProposedAssumption[];
        dependencies: ProposedDependency[];
      }
    | {
        action: "run_point";
        experiment: string;
        point: Record<string, number>;
        ic?: string;
        // The two explanations this experiment tells apart.
        distinguishes: [string, string];
        prediction: Prediction;
      }
    | { action: "revise"; previous: Pin; claim: ProposedClaim; changes: string }
    | { action: "ask_researcher"; question: string }
    | { action: "conclude"; summary: string }
  );

export type DecisionAction = Decision["action"];

const id: Check = (v, path) => {
  str(v, path);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(v as string)) fail(path, "must be a lowercase slug");
};

const claim = shape({ id, title: str, text: str, predicate: any });
const base = { rationale: str, cites: list(str, 50) };
const extra = { surprise: str, escalate: str };

const decision: Check = (v, path) => {
  if (!isObj(v)) return fail(path, "must be an object");
  switch (v.action) {
    case "formulate":
      shape(
        {
          ...base,
          action: any,
          question: str,
          ambiguities: list(text, 10),
          claims: list(claim, 5),
          assumptions: list(shape({ id, title: str, statement: str, scope: str }), 10),
          dependencies: list(shape({ from: id, to: id, reason: str }), 20),
        },
        extra,
      )(v, path);
      return;
    case "run_point":
      shape(
        {
          ...base,
          action: any,
          experiment: id,
          point: numbers,
          distinguishes: (x, p) => {
            list(str, 2)(x, p);
            if ((x as unknown[]).length !== 2) fail(p, "must name exactly two explanations");
          },
          prediction: shape({ outcome: oneOf("holds", "fails"), because: str }),
        },
        { ...extra, ic: str },
      )(v, path);
      return;
    case "revise":
      shape({ ...base, action: any, previous: pin, claim, changes: str }, extra)(v, path);
      return;
    case "ask_researcher":
      shape({ ...base, action: any, question: str }, extra)(v, path);
      return;
    case "conclude":
      shape({ ...base, action: any, summary: str }, extra)(v, path);
      return;
    default:
      return fail(`${path}.action`, "unknown action");
  }
};

export function parseDecision(
  input: unknown,
): { ok: true; decision: Decision } | { ok: false; detail: string } {
  const r = check(decision, input);
  return r.ok ? { ok: true, decision: r.value as Decision } : r;
}
