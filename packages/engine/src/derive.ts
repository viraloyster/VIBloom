// Everything the interface and agents show is derived here from the state;
// nothing in this file is stored.

import type { Currency, Pin, ResultRecord } from "@vibloom/contracts";
import type { State } from "./state";

export interface ResultView {
  id: string;
  currency: Currency;
  relation: "supports" | "refutes" | "none";
  // Why the result is not current, or which hypothetical links it relies on.
  reasons: string[];
  warnings: string[];
}

// Nodes a result needs: its declared pins plus everything they depend on
// through confirmed edges. Hypothetical edges only warn.
function closure(s: State, roots: string[]) {
  const needed = new Set<string>();
  const warnings: string[] = [];
  const stack = [...roots];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (needed.has(id)) continue;
    needed.add(id);
    for (const e of s.edges) {
      if (e.from !== id) continue;
      if (e.state === "confirmed") stack.push(e.to);
      else warnings.push(`relies on hypothetical link ${e.from} -> ${e.to}`);
    }
  }
  return { needed, warnings };
}

function relation(r: ResultRecord): ResultView["relation"] {
  if (r.execution.status !== "completed" || r.violated) return "none";
  if (r.region) {
    if (r.region.status === "counterexample_found") return "refutes";
    return r.region.status === "no_counterexample" ? "supports" : "none";
  }
  if (r.outcome === "fails") return "refutes";
  return r.outcome === "holds" ? "supports" : "none";
}

export function resultView(s: State, r: ResultRecord): ResultView {
  const pins: Pin[] = [r.experiment, r.claim, ...r.assumptions];
  const exp = s.nodes.get(r.experiment.id);
  if (exp?.kind === "experiment") pins.push(exp.spec.model);
  const { needed, warnings } = closure(
    s,
    pins.map((p) => p.id),
  );

  const reasons: string[] = [];
  let currency: Currency = "current";
  for (const id of needed) {
    const n = s.nodes.get(id);
    if (n?.kind === "assumption" && n.state === "off") {
      currency = "unsupported";
      reasons.push(`assumption ${id} is off`);
    }
  }
  for (const p of pins) {
    const n = s.nodes.get(p.id);
    if (n && n.revision !== p.revision && currency === "current") {
      currency = "pending_review";
      reasons.push(`${p.id} changed since revision ${String(p.revision)}`);
    }
  }
  return { id: r.id, currency, relation: relation(r), reasons, warnings };
}

export type Verdict =
  | { verdict: "unexplored" }
  | { verdict: "refuted"; by: string[] }
  | { verdict: "holds"; by: string[] }
  // A region claim never holds; sampling can only fail to find a counterexample.
  | { verdict: "no_counterexample"; by: string[]; evaluated: number }
  | { verdict: "inconclusive" };

export interface ClaimView {
  claim: string;
  revision: number;
  verdict: Verdict;
  // Results that no longer count, kept so the history stays visible.
  notCurrent: ResultView[];
  failedRuns: string[];
}

// Current contrary evidence always wins over current favourable evidence; a
// result that is not current never counts either way.
export function claimView(s: State, claimId: string): ClaimView | undefined {
  const c = s.nodes.get(claimId);
  if (c?.kind !== "claim") return undefined;
  const views = [...s.results.values()]
    .filter((r) => r.claim.id === claimId && r.claim.revision === c.revision)
    .map((r) => ({ r, v: resultView(s, r) }));
  const current = views.filter(({ v }) => v.currency === "current");
  const refuting = current.filter(({ v }) => v.relation === "refutes").map(({ r }) => r.id);
  const supporting = current.filter(({ v }) => v.relation === "supports");

  let verdict: Verdict;
  if (refuting.length > 0) verdict = { verdict: "refuted", by: refuting };
  else if (supporting.length > 0) {
    const by = supporting.map(({ r }) => r.id);
    verdict =
      c.predicate.kind === "FOR_ALL"
        ? {
            verdict: "no_counterexample",
            by,
            evaluated: supporting.reduce(
              (n, { r }) => n + (r.region?.status === "no_counterexample" ? r.region.evaluated : 0),
              0,
            ),
          }
        : { verdict: "holds", by };
  } else if (current.some(({ r }) => r.execution.status === "completed" && !r.violated)) {
    verdict = { verdict: "inconclusive" };
  } else verdict = { verdict: "unexplored" };

  return {
    claim: claimId,
    revision: c.revision,
    verdict,
    notCurrent: views.filter(({ v }) => v.currency !== "current").map(({ v }) => v),
    failedRuns: views
      .filter(({ r }) => r.execution.status !== "completed" || r.violated)
      .map(({ r }) => r.id),
  };
}
