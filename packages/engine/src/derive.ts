// Everything the interface and agents show is derived here from the state;
// nothing in this file is stored.

import type { Currency, Pin, ResultRecord, RootNode } from "@vibloom/contracts";
import { canonical } from "./hash";
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

function roots(s: State, experiment: string, assumptions: readonly string[]) {
  const ids = [experiment, ...assumptions];
  const exp = s.nodes.get(experiment);
  if (exp?.kind === "experiment") ids.push(exp.spec.model.id, exp.spec.claim.id);
  return ids;
}

// What a run on this experiment needs right now, at current revisions. The
// engine stores it in the result as its basis.
export function basisFor(s: State, experiment: string, assumptions: readonly string[]): Pin[] {
  const { needed } = closure(s, roots(s, experiment, assumptions));
  return [...needed]
    .flatMap((id) => {
      const n = s.nodes.get(id);
      return n ? [{ id, revision: n.revision }] : [];
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function resultView(s: State, r: ResultRecord): ResultView {
  const basis = new Map(r.basis.map((p) => [p.id, p.revision]));
  const { needed, warnings } = closure(
    s,
    roots(
      s,
      r.experiment.id,
      r.assumptions.map((a) => a.id),
    ),
  );

  const off: string[] = [];
  const stale: string[] = [];
  for (const id of needed) {
    const n = s.nodes.get(id);
    if (!n) continue;
    if (n.kind === "assumption" && n.state === "off") off.push(`assumption ${id} is off`);
    const used = basis.get(id);
    if (used === undefined) stale.push(`${id} became a dependency after the run`);
    else if (used !== n.revision) stale.push(`${id} changed since revision ${String(used)}`);
  }
  const currency: Currency =
    off.length > 0 ? "unsupported" : stale.length > 0 ? "pending_review" : "current";
  return { id: r.id, currency, relation: relation(r), reasons: [...off, ...stale], warnings };
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

export type LessonSupport =
  | { status: "open"; why: string }
  | { status: "awaiting_test" }
  // Backed under the tested conditions; other causes may still fit.
  | { status: "supported"; candidate: string; result: string }
  | { status: "not_distinguished"; candidates: string[]; result: string }
  | { status: "no_candidate_fits"; result: string };

export interface LessonView {
  id: string;
  support: LessonSupport;
  currency: Currency;
  reasons: string[];
  retired?: { reason: string };
}

type Lesson = Extract<RootNode, { kind: "lesson" }>;

function meets(r: ResultRecord, e: Lesson["candidates"][number]["expect"]): boolean {
  if ("outcome" in e) return r.outcome === e.outcome;
  const x = r.comparison?.relativeError;
  return x !== undefined && x >= e.relativeError.min && x <= e.relativeError.max;
}

// Support comes only from current results of the test the lesson named.
export function lessonView(s: State, id: string): LessonView | undefined {
  const n = s.nodes.get(id);
  if (n?.kind !== "lesson") return undefined;
  const basis = new Map(n.basis.map((b) => [b.id, b.revision]));
  const reasons: string[] = [];
  let currency: Currency = "current";
  for (const [bid, rev] of basis) {
    const b = s.nodes.get(bid);
    if (b?.kind === "assumption" && b.state === "off") {
      currency = "unsupported";
      reasons.push(`assumption ${bid} is off`);
    } else if (b && b.revision !== rev && currency === "current") {
      currency = "pending_review";
      reasons.push(`${bid} changed since revision ${String(rev)}`);
    }
  }

  let support: LessonSupport;
  const test = n.test;
  if (!test) support = { status: "open", why: n.insufficient ?? "no test" };
  else {
    const point = canonical(test.point);
    const runs = [...s.results.values()].filter(
      (r) =>
        r.experiment.id === test.experiment &&
        r.point !== undefined &&
        canonical(r.point) === point &&
        resultView(s, r).currency === "current",
    );
    const r = runs[runs.length - 1];
    if (!r) support = { status: "awaiting_test" };
    else if (r.execution.status !== "completed" || r.violated) {
      support = { status: "open", why: `test run ${r.id} did not complete` };
    } else {
      const fits = n.candidates.filter((c) => meets(r, c.expect)).map((c) => c.id);
      const [only] = fits;
      support =
        fits.length === 1 && only !== undefined
          ? { status: "supported", candidate: only, result: r.id }
          : fits.length > 1
            ? { status: "not_distinguished", candidates: fits, result: r.id }
            : { status: "no_candidate_fits", result: r.id };
    }
  }
  const view: LessonView = { id, support, currency, reasons };
  if (n.retired) view.retired = n.retired;
  return view;
}
