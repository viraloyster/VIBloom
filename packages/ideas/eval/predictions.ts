// Does a lesson help Muse predict the Oregonator, and do its numbers add
// anything? A grid frozen in a file before the run, whose outcomes the solver
// settles first; Muse predicts each point blind with no lesson, with the
// recorded lesson as outcomes only, and with its measured contrast, using the
// prompt the app uses. The lesson's own points are reported apart, so recall
// is not counted as learning. Baselines: always "fails", and a constant
// probability taken from an earlier, separate grid.
//
//   npx vite-node packages/ideas/eval/predictions.ts -- grid.json [reps] [out.json]
//
// The key comes from MUSE_API_KEY, or a proxy that adds it.

import { readFile, writeFile } from "node:fs/promises";
import { runCheck, SIM_PARAMS } from "../src/check";
import { Ledger } from "../src/cost";
import { Muse } from "../src/muse";
import { PREDICT, PREDICT_SCHEMA } from "../src/protocol";
import { IdeaTree } from "../src/tree";
import type { IdeaEvent, Outcome } from "../src/types";

const root = new URL("../../../", import.meta.url);
const gridFile = process.argv[2] ?? "packages/ideas/eval/grid-2.json";
const reps = Number(process.argv[3] ?? 2);
const out = process.argv[4] ?? "eval-predictions.json";
const spec2 = JSON.parse(await readFile(new URL(gridFile, root), "utf8")) as {
  q: number;
  eps: number;
  s: number[];
  eps_prime: number[];
  base_rate_from: string;
};
const earlier = JSON.parse(await readFile(new URL(spec2.base_rate_from, root), "utf8")) as {
  rows: { seen: boolean; truth: Outcome }[];
};
const unseen = earlier.rows.filter((r) => !r.seen);
// Probability of "holds" estimated on the earlier grid only.
const baseRate = unseen.filter((r) => r.truth === "holds").length / unseen.length;
const BUDGET = 1;

// The session the lesson came from, frozen with the evaluation.
const example = new URL("./lesson-session.json", import.meta.url);
const log = JSON.parse(await readFile(example, "utf8")) as { events: IdeaEvent[] };
const base = IdeaTree.replay(log.events);
for (const run of base.runsToConfirm()) {
  const spec = base.nodes.get(run.node)?.check;
  if (spec)
    base.confirm(run.seq, runCheck(spec, { ...base.scope(), ...(run.result.inputs ?? {}) }));
}
const lesson = base.lessons[0];
const node = lesson && base.nodes.get(lesson.node);
const spec = node?.check;
if (!lesson || !node || spec?.kind !== "oregonator") throw new Error("the example has no lesson");

const fixed = { q: spec2.q, eps: spec2.eps };
const seen = [lesson.basis, { ...lesson.basis, [lesson.test.param]: lesson.test.value }];
const grid: Record<string, number>[] = [];
for (const s of spec2.s)
  for (const eps_prime of spec2.eps_prime) grid.push({ ...fixed, s, eps_prime });
const key = (v: Record<string, number>) => SIM_PARAMS.map((k) => String(v[k])).join(",");
const seenKeys = new Set(seen.map(key));
const points = [...seen, ...grid.filter((g) => !seenKeys.has(key(g)))];

// The solver settles every point before Muse is asked anything.
const truth = new Map<string, { outcome: Outcome; difference: number } | string>();
for (const v of points) {
  const r = runCheck(spec, v);
  truth.set(
    key(v),
    "error" in r ? r.error : { outcome: r.pass ? "holds" : "fails", difference: r.value },
  );
}

const ledger = new Ledger(BUDGET);
const muse = new Muse(process.env.MUSE_API_KEY ? { apiKey: process.env.MUSE_API_KEY } : {}, ledger);

// The tree as the app would hold it at a point: values set, lesson kept or not.
type Condition = "none" | "binary" | "quantitative";
const CONDITIONS: Condition[] = ["none", "binary", "quantitative"];
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
  return t.lessonsForModel(lesson?.node ?? "", condition);
}

interface Row {
  point: Record<string, number>;
  seen: boolean;
  condition: Condition;
  rep: number;
  truth: Outcome;
  difference: number;
  expect?: Outcome;
  confidence?: number;
  uses?: string[];
  error?: string;
  cost: number;
  ms: number;
}
const rows: Row[] = [];
for (let rep = 0; rep < reps; rep++) {
  for (const v of points) {
    const t = truth.get(key(v));
    if (!t || typeof t === "string") continue;
    for (const condition of CONDITIONS) {
      const started = Date.now();
      const row: Row = {
        point: v,
        seen: seenKeys.has(key(v)),
        condition,
        rep,
        truth: t.outcome,
        difference: t.difference,
        cost: 0,
        ms: 0,
      };
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
      row.ms = Date.now() - started;
      rows.push(row);
      process.stdout.write(row.error ? "x" : row.expect === row.truth ? "." : "!");
    }
  }
}

function summary(rs: Row[]) {
  const answered = rs.filter((r) => r.expect && r.confidence !== undefined);
  const right = answered.filter((r) => r.expect === r.truth).length;
  const brier =
    answered.reduce((a, r) => {
      const pHolds = r.expect === "holds" ? (r.confidence ?? 0) : 1 - (r.confidence ?? 0);
      return a + (pHolds - (r.truth === "holds" ? 1 : 0)) ** 2;
    }, 0) / Math.max(1, answered.length);
  return {
    n: rs.length,
    unanswered: rs.length - answered.length,
    accuracy: answered.length ? right / answered.length : NaN,
    brier,
    meanConfidence:
      answered.reduce((a, r) => a + (r.confidence ?? 0), 0) / Math.max(1, answered.length),
    citedLesson: answered.filter((r) => r.uses?.length).length,
    cost: rs.reduce((a, r) => a + r.cost, 0),
    meanSeconds: rs.reduce((a, r) => a + r.ms, 0) / Math.max(1, rs.length) / 1000,
  };
}

const groups = Object.fromEntries(
  CONDITIONS.flatMap((condition) =>
    [true, false].map((seen) => [
      `${condition}, ${seen ? "seen" : "new"} points`,
      summary(rows.filter((r) => r.condition === condition && r.seen === seen)),
    ]),
  ),
);
// Baselines on the new points, one forecast per point.
const fresh = points.filter((v) => !seenKeys.has(key(v)));
const outcomes = fresh.flatMap((v) => {
  const t = truth.get(key(v));
  return t && typeof t !== "string" ? [t.outcome] : [];
});
const holdsShare = outcomes.filter((o) => o === "holds").length / outcomes.length;
const baselines = {
  points: outcomes.length,
  alwaysFails: { accuracy: 1 - holdsShare, brier: holdsShare },
  baseRate: {
    probabilityHolds: baseRate,
    accuracy: baseRate < 0.5 ? 1 - holdsShare : holdsShare,
    brier:
      outcomes.reduce((a, o) => a + (baseRate - (o === "holds" ? 1 : 0)) ** 2, 0) / outcomes.length,
  },
};
const excluded = [...truth].filter(([, t]) => typeof t === "string");
console.log("\n" + JSON.stringify({ groups, baselines, excluded, total: ledger.total }, null, 1));
await writeFile(
  out,
  JSON.stringify(
    {
      grid: spec2,
      reps,
      points: [...truth],
      groups,
      baselines,
      excluded,
      rows,
      total: ledger.total,
    },
    null,
    1,
  ),
);
