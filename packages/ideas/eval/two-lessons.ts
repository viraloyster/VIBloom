// Can Muse combine two lessons better than a rule that only fits their
// numbers? The second lesson was learned at another q and eps (see
// second-lesson.ts). On a grid frozen before the run, Muse predicts each point
// blind with no lesson, with the first lesson, and with both, using the app's
// prompt. Baselines see the same four lesson runs Muse sees: log(gap) fitted
// by least squares, on log(eps_prime) alone (one lesson) or with log(q) or
// log(eps) (both lessons; the lessons moved q and eps together, so the two
// rules attribute the change differently). Always "fails" is reported too.
//
//   npx vite-node packages/ideas/eval/two-lessons.ts -- grid.json [reps] [out.json]

import { readFile, writeFile } from "node:fs/promises";
import { runCheck, SIM_PARAMS } from "../src/check";
import { Ledger } from "../src/cost";
import { Muse } from "../src/muse";
import { PREDICT, PREDICT_SCHEMA } from "../src/protocol";
import { IdeaTree } from "../src/tree";
import type { IdeaEvent, Outcome } from "../src/types";

const root = new URL("../../../", import.meta.url);
const gridFile = process.argv[2] ?? "packages/ideas/eval/grid-4.json";
const reps = Number(process.argv[3] ?? 2);
const out = process.argv[4] ?? "eval-two-lessons.json";
const grid = JSON.parse(await readFile(new URL(gridFile, root), "utf8")) as Record<
  "q" | "eps" | "s" | "eps_prime",
  number[]
>;

const log = JSON.parse(
  await readFile(new URL("./lesson-session-2.json", import.meta.url), "utf8"),
) as { events: IdeaEvent[] };
const base = IdeaTree.replay(log.events);
for (const run of base.runsToConfirm()) {
  const spec = base.nodes.get(run.node)?.check;
  if (spec)
    base.confirm(run.seq, runCheck(spec, { ...base.scope(), ...(run.result.inputs ?? {}) }));
}
const [one, two] = base.lessons;
const node = one && base.nodes.get(one.node);
const spec = node?.check;
if (!one || !two || !node || spec?.kind !== "oregonator") throw new Error("two lessons needed");
const tolerance = spec.tolerance;

const key = (v: Record<string, number>) => SIM_PARAMS.map((k) => String(v[k])).join(",");
// The four runs the lessons carry, as Muse receives them.
const lessonRuns = [one.surprise, one.run, two.surprise, two.run].flatMap((seq) => {
  const r = base.runs.find((x) => x.seq === seq)?.result;
  return r && !("error" in r) ? [{ v: r.inputs, gap: r.value }] : [];
});
const seen = new Set(lessonRuns.map((r) => key(r.v)));

const points: Record<string, number>[] = [];
for (const q of grid.q)
  for (const eps of grid.eps)
    for (const s of grid.s)
      for (const eps_prime of grid.eps_prime) points.push({ q, eps, s, eps_prime });

const truth = new Map<string, { outcome: Outcome; gap: number } | string>();
for (const v of points) {
  const r = runCheck(spec, v);
  truth.set(key(v), "error" in r ? r.error : { outcome: r.pass ? "holds" : "fails", gap: r.value });
}

// Least squares of log(gap) on [1, log(x) for each named parameter].
function fit(names: string[], runs: typeof lessonRuns) {
  const X = runs.map((r) => [1, ...names.map((n) => Math.log(r.v[n] ?? NaN))]);
  const y = runs.map((r) => Math.log(r.gap));
  const n = names.length + 1;
  const A = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => X.reduce((s, row) => s + (row[i] ?? 0) * (row[j] ?? 0), 0)),
  );
  const b = Array.from({ length: n }, (_, i) =>
    X.reduce((s, row, k) => s + (row[i] ?? 0) * (y[k] ?? 0), 0),
  );
  // Gaussian elimination on the normal equations.
  for (let i = 0; i < n; i++) {
    const p = A[i]?.[i] ?? NaN;
    for (let j = i + 1; j < n; j++) {
      const f = (A[j]?.[i] ?? 0) / p;
      for (let k = i; k < n; k++) (A[j] as number[])[k] = (A[j]?.[k] ?? 0) - f * (A[i]?.[k] ?? 0);
      b[j] = (b[j] ?? 0) - f * (b[i] ?? 0);
    }
  }
  const c = Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i] ?? 0;
    for (let k = i + 1; k < n; k++) s -= (A[i]?.[k] ?? 0) * (c[k] ?? 0);
    c[i] = s / (A[i]?.[i] ?? NaN);
  }
  return (v: Record<string, number>): Outcome =>
    Math.exp(names.reduce((s, nm, i) => s + (c[i + 1] ?? 0) * Math.log(v[nm] ?? NaN), c[0] ?? 0)) <=
    tolerance
      ? "holds"
      : "fails";
}
const rules = {
  "one lesson, eps_prime": fit(["eps_prime"], lessonRuns.slice(0, 2)),
  "two lessons, eps_prime and q": fit(["eps_prime", "q"], lessonRuns),
  "two lessons, eps_prime and eps": fit(["eps_prime", "eps"], lessonRuns),
};

type Condition = "none" | "one" | "two";
const CONDITIONS: Condition[] = ["none", "one", "two"];
function lessonsAt(v: Record<string, number>, condition: Condition) {
  if (condition === "none") return [];
  const t = IdeaTree.replay(base.events);
  for (const run of t.runsToConfirm()) {
    const r = base.runs.find((x) => x.seq === run.seq);
    if (r) t.confirm(run.seq, r.result);
  }
  for (const k of SIM_PARAMS) {
    if (t.scope()[k] !== v[k])
      t.append("eval", { type: "set_param", name: k, value: v[k] ?? NaN, source: "eval" });
  }
  const all = t.lessonsForModel(node?.id ?? "", "quantitative");
  return condition === "one" ? all.filter((l) => l.id === one?.id) : all;
}

const muse = new Muse(
  process.env.MUSE_API_KEY ? { apiKey: process.env.MUSE_API_KEY } : {},
  new Ledger(3),
);
interface Row {
  point: Record<string, number>;
  condition: Condition;
  rep: number;
  truth: Outcome;
  gap: number;
  expect?: Outcome;
  confidence?: number;
  uses?: string[];
  error?: string;
  cost: number;
}
const rows: Row[] = [];
for (let rep = 0; rep < reps; rep++) {
  for (const v of points) {
    const t = truth.get(key(v));
    if (!t || typeof t === "string" || seen.has(key(v))) continue;
    for (const condition of CONDITIONS) {
      const row: Row = { point: v, condition, rep, truth: t.outcome, gap: t.gap, cost: 0 };
      try {
        const r = await muse.ask(
          {
            instructions: PREDICT,
            input: JSON.stringify({
              assumption: node.statement,
              question: spec.question,
              tolerance: spec.tolerance,
              values: v,
              lessons: lessonsAt(v, condition),
            }),
            mode: "standard",
            effort: "low",
            maxOutput: 4000,
          },
          "prediction",
          PREDICT_SCHEMA,
        );
        const p = r.value as { expect: Outcome; confidence: number; uses: string[] };
        Object.assign(row, {
          expect: p.expect,
          confidence: Math.min(0.99, Math.max(0.5, p.confidence)),
          uses: p.uses,
          cost: r.usage.cost,
        });
      } catch (e) {
        row.error = e instanceof Error ? e.message : String(e);
      }
      rows.push(row);
      process.stdout.write(row.error ? "x" : row.expect === row.truth ? "." : "!");
    }
  }
}

const summary = (rs: Row[]) => {
  const a = rs.filter((r) => r.expect && r.confidence !== undefined);
  return {
    n: rs.length,
    unanswered: rs.length - a.length,
    right: a.filter((r) => r.expect === r.truth).length,
    accuracy: a.filter((r) => r.expect === r.truth).length / Math.max(1, a.length),
    brier:
      a.reduce((s, r) => {
        const p = r.expect === "holds" ? (r.confidence ?? 0) : 1 - (r.confidence ?? 0);
        return s + (p - (r.truth === "holds" ? 1 : 0)) ** 2;
      }, 0) / Math.max(1, a.length),
    meanConfidence: a.reduce((s, r) => s + (r.confidence ?? 0), 0) / Math.max(1, a.length),
    citedLesson: a.filter((r) => r.uses?.length).length,
    cost: rs.reduce((s, r) => s + r.cost, 0),
  };
};
const fresh = points.filter((v) => {
  const t = truth.get(key(v));
  return t && typeof t !== "string" && !seen.has(key(v));
});
const outcomeOf = (v: Record<string, number>) => {
  const t = truth.get(key(v));
  return t && typeof t !== "string" ? t.outcome : undefined;
};
const result = {
  grid,
  reps,
  lessons: [one, two].map((l) => ({ id: l.id, basis: l.basis, test: l.test })),
  lessonRuns,
  points: fresh.length,
  holds: fresh.filter((v) => outcomeOf(v) === "holds").length,
  excluded: [...truth].filter(([, t]) => typeof t === "string"),
  conditions: Object.fromEntries(
    CONDITIONS.map((c) => [c, summary(rows.filter((r) => r.condition === c))]),
  ),
  baselines: {
    ...Object.fromEntries(
      Object.entries(rules).map(([name, rule]) => [
        name,
        fresh.filter((v) => rule(v) === outcomeOf(v)).length / fresh.length,
      ]),
    ),
    "always fails": fresh.filter((v) => outcomeOf(v) === "fails").length / fresh.length,
  },
  total: muse.ledger.total,
  rows,
};
console.log("\n" + JSON.stringify({ ...result, rows: undefined }, null, 1));
await writeFile(out, JSON.stringify(result, null, 1));
