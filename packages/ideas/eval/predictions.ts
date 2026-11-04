// Does a lesson help Muse predict the Oregonator, and do its numbers add
// anything? A grid frozen in a file before the run, whose outcomes the solver
// settles first; Muse predicts each point blind with no lesson, with the
// recorded lesson as outcomes only, and with its measured contrast, using the
// prompt the app uses. The lesson's own points are reported apart, so recall
// is not counted as learning. Baselines: always "fails", a constant
// probability taken from an earlier, separate grid, and a rule with no model
// at all that interpolates the lesson's two measured gaps in eps_prime
// (log-log) and calls "fails" above the tolerance. If that rule matches Muse,
// the lesson's numbers did the work, not Muse.
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
  q: number | number[];
  eps: number | number[];
  s: number[];
  eps_prime: number[];
  base_rate_from: string;
};
const list = (x: number | number[]) => (Array.isArray(x) ? x : [x]);
const earlier = JSON.parse(await readFile(new URL(spec2.base_rate_from, root), "utf8")) as {
  rows: { seen: boolean; truth: Outcome }[];
};
const unseen = earlier.rows.filter((r) => !r.seen);
// Probability of "holds" estimated on the earlier grid only.
const baseRate = unseen.filter((r) => r.truth === "holds").length / unseen.length;
const BUDGET = 3;

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

const seen = [lesson.basis, { ...lesson.basis, [lesson.test.param]: lesson.test.value }];
const grid: Record<string, number>[] = [];
for (const q of list(spec2.q))
  for (const eps of list(spec2.eps))
    for (const s of spec2.s)
      for (const eps_prime of spec2.eps_prime) grid.push({ q, eps, s, eps_prime });
// Whether a point shares every value with the lesson except eps_prime, the
// one parameter its test changed.
const onLessonLine = (v: Record<string, number>) =>
  SIM_PARAMS.every((k) => k === "eps_prime" || v[k] === lesson.basis[k]);
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
// The model-free rule: log(gap) linear in log(eps_prime) through the lesson's
// two runs, everything else ignored.
const gapOf = (seq: number | undefined) => {
  const r = base.runs.find((x) => x.seq === seq)?.result;
  return r && !("error" in r) ? { ep: r.inputs.eps_prime ?? NaN, gap: r.value } : undefined;
};
const [a, b] = [gapOf(lesson.surprise), gapOf(lesson.run)];
if (!a || !b) throw new Error("the lesson has no measured gaps");
const slope = Math.log(b.gap / a.gap) / Math.log(b.ep / a.ep);
const interpolated = (v: Record<string, number>): Outcome =>
  a.gap * ((v.eps_prime ?? NaN) / a.ep) ** slope <= spec.tolerance ? "holds" : "fails";
const ruleRows = fresh.flatMap((v) => {
  const t = truth.get(key(v));
  return t && typeof t !== "string" ? [{ v, right: interpolated(v) === t.outcome }] : [];
});
const ruleOn = (rs: typeof ruleRows) =>
  rs.length ? rs.filter((r) => r.right).length / rs.length : NaN;
// Muse's accuracy on the same split, so the comparison is like for like.
const museOn = (line: boolean) =>
  Object.fromEntries(
    CONDITIONS.map((c) => {
      const rs = rows.filter(
        (r) => r.condition === c && !r.seen && r.expect && onLessonLine(r.point) === line,
      );
      return [c, rs.length ? rs.filter((r) => r.expect === r.truth).length / rs.length : NaN];
    }),
  );
const split = {
  onLessonLine: {
    points: ruleRows.filter((r) => onLessonLine(r.v)).length,
    interpolation: ruleOn(ruleRows.filter((r) => onLessonLine(r.v))),
    muse: museOn(true),
  },
  offLessonLine: {
    points: ruleRows.filter((r) => !onLessonLine(r.v)).length,
    interpolation: ruleOn(ruleRows.filter((r) => !onLessonLine(r.v))),
    muse: museOn(false),
  },
};
const baselines = {
  points: outcomes.length,
  interpolation: { slope, accuracy: ruleOn(ruleRows) },
  split,
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
