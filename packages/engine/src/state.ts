// Projection of the event log and the write gate. Every op is checked against
// a draft of the state; a command applies completely or not at all.

import {
  validateClaim,
  type Contract,
  type DependsOn,
  type ResultRecord,
  type RootNode,
} from "@vibloom/contracts";
import type { Actor, Op, Rejection, RejectionCode } from "./commands";

export interface State {
  head: number;
  lastHash: string;
  nodes: Map<string, RootNode>;
  edges: DependsOn[];
  results: Map<string, ResultRecord>;
}

export const GENESIS = "genesis";

export function emptyState(): State {
  return { head: 0, lastHash: GENESIS, nodes: new Map(), edges: [], results: new Map() };
}

export function cloneState(s: State): State {
  return {
    head: s.head,
    lastHash: s.lastHash,
    nodes: new Map([...s.nodes].map(([k, v]) => [k, structuredClone(v)])),
    edges: s.edges.map((e) => ({ ...e })),
    results: new Map([...s.results].map(([k, v]) => [k, structuredClone(v)])),
  };
}

class GateError extends Error {
  readonly code: RejectionCode;
  constructor(code: RejectionCode, detail: string) {
    super(detail);
    this.code = code;
  }
}

function reject(code: RejectionCode, detail: string): never {
  throw new GateError(code, detail);
}

function node(s: State, id: string): RootNode {
  return s.nodes.get(id) ?? reject("not_found", `node ${id} does not exist`);
}

function pinned(s: State, pin: { id: string; revision: number }, kind: RootNode["kind"]) {
  const n = node(s, pin.id);
  if (n.kind !== kind) reject("invalid_input", `${pin.id} is not a ${kind}`);
  if (!Number.isInteger(pin.revision) || pin.revision < 1 || pin.revision > n.revision) {
    reject("invalid_input", `${pin.id} has no revision ${String(pin.revision)}`);
  }
  return n;
}

// True when `to` already reaches `from`, so adding from -> to closes a cycle.
function reaches(s: State, start: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [start];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of s.edges) if (e.from === id) stack.push(e.to);
  }
  return false;
}

function addEdge(s: State, e: DependsOn) {
  node(s, e.from);
  node(s, e.to);
  if (e.from === e.to) reject("invalid_input", "a node cannot depend on itself");
  if (s.edges.some((x) => x.from === e.from && x.to === e.to)) {
    reject("invalid_input", `edge ${e.from} -> ${e.to} exists`);
  }
  if (reaches(s, e.to, e.from)) reject("invalid_input", "dependencies must stay acyclic");
  s.edges.push({ ...e });
}

const isText = (v: unknown) => typeof v === "string" && v.trim().length > 0;

function applyOp(s: State, op: Op, actor: Actor, approved: boolean, contract: Contract) {
  switch (op.op) {
    case "add_node": {
      const n = op.node;
      if (!isText(n.id) || !isText(n.title)) reject("invalid_input", "id and title are required");
      if (s.nodes.has(n.id)) reject("conflict", `node ${n.id} exists`);
      switch (n.kind) {
        case "assumption":
          if (actor === "agent" && n.state !== "hypothetical") {
            reject("forbidden", "an agent can only add hypothetical assumptions");
          }
          if (n.protected && !(actor === "human" && approved)) {
            reject("needs_approval", "protected assumptions need human approval");
          }
          break;
        case "invariant":
          if (actor === "agent") reject("forbidden", "invariants are set by people and code");
          break;
        case "source":
          if (!/^[0-9a-f]{64}$/.test(n.sha256)) reject("invalid_input", "sha256 must be 64 hex");
          break;
        case "model":
          break;
        case "claim": {
          const problems = validateClaim(contract, n.predicate);
          if (problems.length > 0) {
            reject("invalid_input", problems.map((p) => `${p.path}: ${p.message}`).join("; "));
          }
          if (n.supersedes) {
            const prev = pinned(s, n.supersedes, "claim");
            if (prev.kind === "claim" && n.version !== prev.version + 1) {
              reject("invalid_input", "a new claim version must follow the previous one");
            }
          } else if (n.version !== 1) {
            reject("invalid_input", "a first claim version is version 1");
          }
          break;
        }
        case "experiment":
          pinned(s, n.spec.model, "model");
          pinned(s, n.spec.claim, "claim");
          if (n.results.length > 0) reject("invalid_input", "an experiment starts without results");
          break;
        default:
          // Unreachable after parsing; kept so the gate never trusts types alone.
          return reject("invalid_input", "unknown node kind");
      }
      s.nodes.set(n.id, { ...structuredClone(n), revision: 1 });
      if (n.kind === "experiment") {
        for (const to of [n.spec.model.id, n.spec.claim.id]) {
          addEdge(s, { from: n.id, to, origin: "spec", state: "confirmed" });
        }
      }
      return;
    }

    case "set_assumption": {
      const n = node(s, op.id);
      if (n.kind !== "assumption") reject("invalid_input", `${op.id} is not an assumption`);
      if (n.revision !== op.expectedRevision) {
        reject("conflict", `${op.id} is at revision ${String(n.revision)}`);
      }
      if (n.protected && !(actor === "human" && approved)) {
        reject("needs_approval", `${op.id} is protected`);
      }
      if (actor === "agent" && op.change.state === "adopted") {
        reject("forbidden", "only a person adopts an assumption");
      }
      const { statement, scope, state } = op.change;
      const next = { ...n, revision: n.revision + 1 };
      if (statement !== undefined) next.statement = statement;
      if (scope !== undefined) next.scope = scope;
      if (state !== undefined) {
        if (!["adopted", "hypothetical", "off"].includes(state))
          reject("invalid_input", "bad state");
        next.state = state;
      }
      s.nodes.set(op.id, next);
      return;
    }

    case "add_edge": {
      const e = op.edge;
      if (e.origin === "spec") reject("forbidden", "spec edges come from experiment specs");
      if (e.origin === "model" && (actor !== "agent" || e.state !== "hypothetical")) {
        reject("invalid_input", "model edges are proposed by the agent as hypothetical");
      }
      if (e.origin === "human" && actor !== "human") reject("forbidden", "not a human command");
      addEdge(s, e);
      return;
    }

    case "confirm_edge": {
      if (actor !== "human") reject("forbidden", "only a person confirms a dependency");
      const e = s.edges.find((x) => x.from === op.from && x.to === op.to);
      if (!e) reject("not_found", `edge ${op.from} -> ${op.to} does not exist`);
      else e.state = "confirmed";
      return;
    }

    case "record_result": {
      const r = op.result;
      if (actor !== "engine") reject("forbidden", "results are issued by the engine");
      if (!isText(r.id)) reject("invalid_input", "result id is required");
      if (s.results.has(r.id)) reject("conflict", `result ${r.id} exists`);
      const exp = pinned(s, r.experiment, "experiment");
      pinned(s, r.claim, "claim");
      for (const a of r.assumptions) pinned(s, a, "assumption");
      if (r.violated) pinned(s, r.violated.invariant, "invariant");
      if (exp.kind === "experiment" && exp.spec.claim.id !== r.claim.id) {
        reject("invalid_input", "a result belongs to the claim of its experiment");
      }
      const basis = new Map<string, number>();
      for (const b of r.basis) {
        const n = node(s, b.id);
        if (basis.has(b.id)) reject("invalid_input", `basis lists ${b.id} twice`);
        if (b.revision < 1 || b.revision > n.revision) {
          reject("invalid_input", `basis pins a revision ${b.id} never had`);
        }
        basis.set(b.id, b.revision);
      }
      const declared = [r.experiment, r.claim, ...r.assumptions];
      if (exp.kind === "experiment") declared.push(exp.spec.model);
      for (const d of declared) {
        if (basis.get(d.id) !== d.revision) {
          reject("invalid_input", `basis must include ${d.id} at revision ${String(d.revision)}`);
        }
      }
      s.results.set(r.id, structuredClone(r));
      if (exp.kind === "experiment") exp.results.push(r.id);
      return;
    }

    case "delete_result":
    case "edit_result":
      return reject("forbidden", "results are immutable");
    case "edit_invariant":
      return reject("forbidden", "invariants cannot be relaxed or removed");
    case "edit_claim":
      return reject("forbidden", "a claim version is immutable; propose a new version");
    case "set_verdict":
      return reject("forbidden", "verdicts are derived from evidence");
    default:
      return reject("invalid_input", "unknown operation");
  }
}

export function applyOps(
  state: State,
  ops: Op[],
  actor: Actor,
  approved: boolean,
  contract: Contract,
): { ok: true; state: State } | Rejection {
  if (ops.length === 0) return { ok: false, code: "invalid_input", detail: "empty command" };
  if (approved && actor !== "human") {
    return { ok: false, code: "invalid_input", detail: "only a person can approve" };
  }
  const draft = cloneState(state);
  for (const [i, op] of ops.entries()) {
    try {
      applyOp(draft, op, actor, approved, contract);
    } catch (e) {
      if (e instanceof GateError) return { ok: false, code: e.code, op: i, detail: e.message };
      return { ok: false, code: "invalid_input", op: i, detail: "malformed operation" };
    }
  }
  return { ok: true, state: draft };
}
