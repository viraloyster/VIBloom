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

type Level = "details_and_history" | "details" | "summary" | "title";

const FOLDER: Record<string, string> = {
  assumption: "assumptions",
  invariant: "invariants",
  source: "sources",
  model: "models",
  experiment: "experiments",
  claim: "claims",
  lesson: "lessons",
};

// Graph distance from the focus, through dependencies in either direction.
function distances(s: State, focus: string): Map<string, number> {
  const d = new Map<string, number>([[focus, 0]]);
  const queue = [focus];
  for (const cur of queue) {
    for (const e of s.edges) {
      const next = e.from === cur ? e.to : e.to === cur ? e.from : undefined;
      if (next !== undefined && !d.has(next)) {
        d.set(next, (d.get(cur) ?? 0) + 1);
        queue.push(next);
      }
    }
  }
  return d;
}

function levelOf(dist: number | undefined): Level {
  if (dist === undefined) return "title";
  if (dist <= 1) return "details_and_history";
  if (dist === 2) return "details";
  return dist === 3 ? "summary" : "title";
}

const short = (text: string) => (text.length > 140 ? `${text.slice(0, 137)}...` : text);

// The project as the model sees it: a virtual folder tree whose detail depends
// on distance from the root the researcher is working on. Everything the focus
// rests on is always given in full.
export function renderContext(s: State, focus?: string): string {
  const fo = focus ? focusOf(s, focus) : undefined;
  const dist = focus && fo ? distances(s, focus) : undefined;
  const required = new Set(fo?.restsOn ?? []);
  const level = (id: string): Level => {
    if (!dist) return "details";
    const l = levelOf(dist.get(id));
    return required.has(id) && (l === "summary" || l === "title") ? "details" : l;
  };

  const detailed = new Set<string>();
  const tree: Record<string, unknown[]> = {};
  for (const n of s.nodes.values()) {
    const l = level(n.id);
    let entry: Record<string, unknown>;
    if (l === "title") entry = { id: n.id, title: n.title, level: l };
    else if (l === "summary") {
      const text =
        n.kind === "assumption" || n.kind === "lesson"
          ? n.statement
          : n.kind === "claim"
            ? n.text
            : n.title;
      entry = { id: n.id, title: n.title, summary: short(text), level: l };
    } else {
      detailed.add(n.id);
      entry = { ...n, level: l };
      if (l === "details_and_history") {
        entry.history = [...s.results.values()]
          .filter(
            (r) =>
              r.claim.id === n.id || r.experiment.id === n.id || r.basis.some((b) => b.id === n.id),
          )
          .map((r) => ({ result: r.id, outcome: r.outcome, currency: resultView(s, r).currency }));
      }
    }
    const folder = FOLDER[n.kind] ?? "other";
    (tree[folder] ??= []).push({ path: `${folder}/${n.id}`, ...entry });
  }

  // Results in full where they touch detailed roots; elsewhere only counted.
  const results: unknown[] = [];
  let summarised = 0;
  for (const r of s.results.values()) {
    const touches = detailed.has(r.claim.id) || detailed.has(r.experiment.id);
    if (!touches) {
      summarised++;
      continue;
    }
    const v = resultView(s, r);
    results.push({
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
    });
  }
  const claims = [...s.nodes.values()]
    .filter((n) => n.kind === "claim")
    .map((n) => ({ claim: n.id, verdict: claimView(s, n.id)?.verdict }));
  const lessons = [...s.nodes.values()]
    .filter((n) => n.kind === "lesson" && !n.retired)
    .map((n) => lessonView(s, n.id));

  return JSON.stringify({
    head: s.head,
    focus: fo,
    tree,
    edges: s.edges,
    results,
    resultsNotShown: summarised,
    claims,
    lessons,
  });
}
