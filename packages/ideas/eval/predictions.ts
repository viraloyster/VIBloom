// Does Muse predict the Oregonator better with a lesson than without one?
// A fixed grid of points whose outcomes the solver settles first; Muse
// predicts each point blind, with and without the recorded lesson, and the
// same prompt the app uses. Points the lesson was learned at are reported
// apart from new ones, so memorising a seen point is not counted as learning.
//
//   npx vite-node packages/ideas/eval/predictions.ts -- [reps] [out.json]
//
// The key comes from MUSE_API_KEY, or a proxy that adds it.

import { readFile, writeFile } from "node:fs/promises";
import { runCheck, SIM_PARAMS } from "../src/check";
import { Ledger } from "../src/cost";
import { Muse } from "../src/muse";
import { PREDICT, PREDICT_SCHEMA } from "../src/protocol";
import { IdeaTree } from "../src/tree";
import type { IdeaEvent, Outcome } from "../src/types";

const reps = Number(process.argv[2] ?? 2);
const out = process.argv[3] ?? "eval-predictions.json";
const BUDGET = 1;

const example = new URL("../../../apps/web/public/examples/period-reduction.json", import.meta.url);
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

const fixed = { q: lesson.basis.q ?? NaN, eps: lesson.basis.eps ?? NaN };
const seen = [lesson.basis, { ...lesson.basis, [lesson.test.param]: lesson.test.value }];
const grid: Record<string, number>[] = [];
for (const s of [0.75, 1, 1.5, 2])
  for (const eps_prime of [1e-5, 5e-5, 2e-4, 1e-3]) grid.push({ ...fixed, s, eps_prime });
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
function lessonsAt(v: Record<string, number>, withLesson: boolean) {
  if (!withLesson) return [];
  const t = IdeaTree.replay(base.events);
  for (const run of t.runsToConfirm()) {
    const r = base.runs.find((x) => x.seq === run.seq);
    if (r) t.confirm(run.seq, r.result);
  }
  for (const k of SIM_PARAMS) {
    if (t.scope()[k] !== v[k])
      t.append("eval", { type: "set_param", name: k, value: v[k] ?? NaN, source: "eval" });
  }
  return t.lessonsForModel(lesson?.node ?? "");
}

interface Row {
  point: Record<string, number>;
  seen: boolean;
  withLesson: boolean;
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
    for (const withLesson of [false, true]) {
      const started = Date.now();
      const row: Row = {
        point: v,
        seen: seenKeys.has(key(v)),
        withLesson,
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
              lessons: lessonsAt(v, withLesson),
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
  [false, true].flatMap((withLesson) =>
    [true, false].map((s) => [
      `${withLesson ? "with" : "without"} lesson, ${s ? "seen" : "new"} points`,
      summary(rows.filter((r) => r.withLesson === withLesson && r.seen === s)),
    ]),
  ),
);
const excluded = [...truth].filter(([, t]) => typeof t === "string");
console.log("\n" + JSON.stringify({ groups, excluded, total: ledger.total }, null, 1));
await writeFile(
  out,
  JSON.stringify(
    { reps, points: [...truth], groups, excluded, rows, total: ledger.total },
    null,
    1,
  ),
);
