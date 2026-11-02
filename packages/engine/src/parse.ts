// Closed runtime validation of commands. Types vanish at runtime, so every
// discriminant, field and value is checked before the gate sees a command.

import {
  any,
  bool,
  check,
  fail,
  int,
  isObj,
  list,
  num,
  numbers,
  oneOf,
  pin,
  shape,
  str,
  text,
  type Check,
} from "@vibloom/contracts";
import type { Command } from "./commands";

const expectation: Check = (v, path) => {
  if (isObj(v) && "outcome" in v) {
    shape({ outcome: oneOf("holds", "fails") })(v, path);
    return;
  }
  shape({ relativeError: shape({ min: num, max: num }) })(v, path);
};

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
    case "lesson":
      shape(
        {
          ...base,
          kind: any,
          statement: str,
          scope: str,
          about: str,
          discrepancy: shape(
            { predicted: oneOf("holds", "fails") },
            {
              observed: oneOf("holds", "fails", "inconclusive", "not_applicable"),
              relativeError: num,
              tolerance: num,
            },
          ),
          candidates: list(
            shape({ id: str, explanation: str, suspects: list(str, 20), expect: expectation }),
            4,
          ),
          basis: list(pin, 5000),
        },
        {
          test: shape({ experiment: str, point: numbers }),
          insufficient: str,
          retired: shape({ reason: str }),
        },
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
    ic: str,
    measurements: list(
      shape(
        {
          model: str,
          execution,
          observation: oneOf("oscillation", "steady_state", "indeterminate"),
          horizon: num,
          runs: int(1),
        },
        { period: num },
      ),
      10,
    ),
    comparison: shape({ reference: str, reduced: str, relativeError: num, tolerance: num }),
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
    case "retire_lesson":
      shape({ op: any, id: str, expectedRevision: int(1), reason: str })(v, path);
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
  // check() clones the input, so later mutation by the caller cannot reach the log.
  const r = check(command, input);
  return r.ok ? { ok: true, command: r.value as Command } : r;
}
