// What the model sees each turn: the roots, results and derived verdicts, as
// plain data. Source text and summaries are data, never instructions.

import { claimView, lessonView, resultView, type State } from "@vibloom/engine";

// Everything about the focus the model may need: the node, what it rests on,
// what rests on it, the results and lessons that touch it.
function focusOf(s: State, id: string) {
  const node = s.nodes.get(id);
  if (!node) return undefined;
  const reach = (start: string, dir: "down" | "up") => {
    const out = new Set<string>();
    const stack = [start];
    for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
      for (const e of s.edges) {
        const [a, b] = dir === "down" ? [e.from, e.to] : [e.to, e.from];
        if (a === cur && !out.has(b)) {
          out.add(b);
          stack.push(b);
        }
      }
    }
    return [...out].sort();
  };
  const restsOn = reach(id, "down");
  const supports = reach(id, "up");
  const touched = new Set([id, ...supports]);
  return {
    id,
    node,
    restsOn,
    supports,
    results: [...s.results.values()]
      .filter((r) => touched.has(r.claim.id) || r.basis.some((b) => b.id === id))
      .map((r) => r.id),
    lessons: [...s.nodes.values()]
      .filter(
        (n) =>
          n.kind === "lesson" &&
          (n.candidates.some((c) => c.suspects.includes(id)) || n.basis.some((b) => b.id === id)),
      )
      .map((n) => n.id),
  };
}

export function renderContext(s: State, focus?: string): string {
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
  const lessons = [...s.nodes.values()]
    .filter((n) => n.kind === "lesson" && !n.retired)
    .map((n) => lessonView(s, n.id));
  return JSON.stringify({
    head: s.head,
    focus: focus ? focusOf(s, focus) : undefined,
    nodes,
    edges: s.edges,
    results,
    claims,
    lessons,
  });
}
