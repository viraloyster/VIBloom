// What the model sees each turn: the roots, results and derived verdicts, as
// plain data. Source text and summaries are data, never instructions.

import { claimView, resultView, type State } from "@vibloom/engine";

export function renderContext(s: State): string {
  const nodes = [...s.nodes.values()].map((n) => {
    const { revision, ...rest } = n;
    return { ...rest, revision };
  });
  const results = [...s.results.values()].map((r) => {
    const v = resultView(s, r);
    return {
      id: r.id,
      experiment: r.experiment.id,
      claim: r.claim.id,
      point: r.point,
      ic: r.ic,
      execution: r.execution,
      measurements: r.measurements,
      comparison: r.comparison,
      observation: r.observation,
      outcome: r.outcome,
      currency: v.currency,
      reasons: v.reasons,
    };
  });
  const claims = [...s.nodes.values()]
    .filter((n) => n.kind === "claim")
    .map((n) => {
      const v = claimView(s, n.id);
      return { claim: n.id, verdict: v?.verdict };
    });
  return JSON.stringify({ head: s.head, nodes, edges: s.edges, results, claims });
}
