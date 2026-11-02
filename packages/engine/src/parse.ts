// Closed runtime validation of commands. Types vanish at runtime, so every
// discriminant, field and value is checked before the gate sees a command.

import type { Command } from "./commands";

export class ParseError extends Error {}

type Check = (v: unknown, path: string) => void;

const fail = (path: string, message: string): never => {
  throw new ParseError(`${path}: ${message}`);
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const MAX_TEXT = 20_000;

const str: Check = (v, path) => {
  if (typeof v !== "string" || v.trim().length === 0) fail(path, "must be a non-empty string");
  else if (v.length > MAX_TEXT) fail(path, "is too long");
};
const text: Check = (v, path) => {
  if (typeof v !== "string") fail(path, "must be a string");
  else if (v.length > MAX_TEXT) fail(path, "is too long");
};
const int =
  (min: number): Check =>
  (v, path) => {
    if (!Number.isSafeInteger(v) || (v as number) < min)
      fail(path, `must be an integer >= ${String(min)}`);
  };
const num: Check = (v, path) => {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(path, "must be a finite number");
};
const bool: Check = (v, path) => {
  if (typeof v !== "boolean") fail(path, "must be a boolean");
};
const oneOf =
  (...values: string[]): Check =>
  (v, path) => {
    if (typeof v !== "string" || !values.includes(v))
      fail(path, `must be one of ${values.join(", ")}`);
  };
const any: Check = () => undefined;

function shape(required: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return (v, path) => {
    if (!isObj(v)) return fail(path, "must be an object");
    for (const k of Object.keys(v)) {
      if (!Object.hasOwn(required, k) && !Object.hasOwn(optional, k))
        fail(`${path}.${k}`, "unknown field");
    }
    for (const [k, check] of Object.entries(required)) {
      if (!Object.hasOwn(v, k)) fail(`${path}.${k}`, "missing field");
      check(v[k], `${path}.${k}`);
    }
    for (const [k, check] of Object.entries(optional)) {
      if (Object.hasOwn(v, k) && v[k] !== undefined) check(v[k], `${path}.${k}`);
    }
  };
}

const list =
  (item: Check, max: number): Check =>
  (v, path) => {
    if (!Array.isArray(v)) return fail(path, "must be an array");
    if (v.length > max) fail(path, `has more than ${String(max)} items`);
    v.forEach((x, i) => {
      item(x, `${path}[${String(i)}]`);
    });
  };

const numbers: Check = (v, path) => {
  if (!isObj(v)) return fail(path, "must be an object");
  for (const [k, x] of Object.entries(v)) num(x, `${path}.${k}`);
};

const pin = shape({ id: str, revision: int(1) });

const node: Check = (v, path) => {
  const base = { id: str, title: str };
  if (!isObj(v)) return fail(path, "must be an object");
  switch (v.kind) {
    case "assumption":
      shape({
        ...base,
        kind: any,
        statement: str,
        scope: str,
        state: oneOf("adopted", "hypothetical", "off"),
        protected: bool,
      })(v, path);
      return;
    case "invariant":
      shape({ ...base, kind: any, check: str, version: str, scope: str })(v, path);
      return;
    case "source":
      shape({ ...base, kind: any, reference: str, version: str, sha256: str })(v, path);
      return;
    case "model":
      shape(
        {
          ...base,
          kind: any,
          name: str,
          version: str,
          equations: str,
          params: numbers,
          scaling: str,
        },
        { mapping: str },
      )(v, path);
      return;
    case "experiment":
      shape({
        ...base,
        kind: any,
        spec: shape(
          { model: pin, claim: pin, solver: str, detector: str, protocol: str },
          { seed: int(0) },
        ),
        results: list(str, 0),
      })(v, path);
      return;
    case "claim":
      // The predicate itself is checked against the contract by the gate.
      shape(
        { ...base, kind: any, version: int(1), text: str, predicate: any, protocol: str },
        { supersedes: pin },
      )(v, path);
      return;
    default:
      return fail(`${path}.kind`, "unknown node kind");
  }
};

const execution: Check = (v, path) => {
  if (isObj(v) && v.status === "failed") {
    shape({
      status: any,
      reason: oneOf(
        "budget_exhausted",
        "step_too_small",
        "singular_system",
        "non_finite",
        "domain_exit",
      ),
    })(v, path);
    return;
  }
  shape({ status: oneOf("completed", "cancelled") })(v, path);
};

const region: Check = (v, path) => {
  if (!isObj(v)) return fail(path, "must be an object");
  switch (v.status) {
    case "unexplored":
      shape({ status: any })(v, path);
      return;
    case "counterexample_found":
      shape({
        status: any,
        counterexamples: int(1),
        evaluated: int(1),
        inconclusive: int(0),
      })(v, path);
      return;
    case "no_counterexample":
      shape({ status: any, evaluated: int(1), inconclusive: int(0) })(v, path);
      return;
    default:
      return fail(`${path}.status`, "unknown region status");
  }
};

const result = shape(
  {
    id: str,
    experiment: pin,
    claim: pin,
    assumptions: list(pin, 1000),
    basis: list(pin, 5000),
    execution,
  },
  {
    observation: oneOf("oscillation", "steady_state", "indeterminate"),
    point: numbers,
    outcome: oneOf("holds", "fails", "inconclusive", "not_applicable"),
    region,
    violated: shape({ invariant: pin, detail: text }),
  },
);

const edge = shape(
  {
    from: str,
    to: str,
    origin: oneOf("spec", "human", "model"),
    state: oneOf("confirmed", "hypothetical"),
  },
  { citation: shape({ source: pin, locator: str, quote: str }, { context: text }) },
);

const op: Check = (v, path) => {
  if (!isObj(v)) return fail(path, "must be an object");
  switch (v.op) {
    case "add_node":
      shape({ op: any, node })(v, path);
      return;
    case "set_assumption":
      shape({
        op: any,
        id: str,
        expectedRevision: int(1),
        change: shape(
          {},
          { statement: str, scope: str, state: oneOf("adopted", "hypothetical", "off") },
        ),
      })(v, path);
      return;
    case "add_edge":
      shape({ op: any, edge })(v, path);
      return;
    case "confirm_edge":
      shape({ op: any, from: str, to: str })(v, path);
      return;
    case "record_result":
      shape({ op: any, result })(v, path);
      return;
    case "delete_result":
    case "edit_invariant":
    case "edit_claim":
      shape({ op: any, id: str })(v, path);
      return;
    case "edit_result":
      shape({ op: any, result: any })(v, path);
      return;
    case "set_verdict":
      shape({ op: any, claim: str, verdict: text })(v, path);
      return;
    default:
      return fail(`${path}.op`, "unknown operation");
  }
};

const command = shape(
  {
    commandId: str,
    actor: oneOf("human", "agent", "engine"),
    baseHead: int(0),
    ops: list(op, 200),
  },
  { approved: bool },
);

export function parseCommand(
  input: unknown,
): { ok: true; command: Command } | { ok: false; detail: string } {
  try {
    command(input, "$");
    // Detach from the caller so later mutation cannot reach the log.
    return { ok: true, command: structuredClone(input) as Command };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, detail: e.message };
    return { ok: false, detail: "malformed command" };
  }
}
