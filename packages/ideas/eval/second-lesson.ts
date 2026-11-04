// Continues the evaluated lesson session at a q the first lesson never
// varied, with the app's own loop: Muse predicts blind with the first lesson,
// the engine runs, and on a surprise Muse registers two explanations and a
// test that the engine runs. Stops at the first lesson learned; writes the
// extended log.
//
//   npx vite-node packages/ideas/eval/second-lesson.ts -- out.json
//
// The key comes from MUSE_API_KEY, or a proxy that adds it.

import { readFile, writeFile } from "node:fs/promises";
import { runCheck, SIM_PARAMS } from "../src/check";
import { Ledger } from "../src/cost";
import { Muse } from "../src/muse";
import { DIAGNOSE, DIAGNOSE_SCHEMA, PREDICT, PREDICT_SCHEMA } from "../src/protocol";
import { IdeaTree } from "../src/tree";
import type { IdeaEvent, Outcome } from "../src/types";

const out = process.argv[2] ?? "lesson-session-2.json";
// Points where the first lesson, read as a rule, says "fails" and the
// engine says "holds" (evaluation 3), tried in order until one surprises Muse.
const CANDIDATES = [
  { q: 3e-4, eps: 0.01, s: 1, eps_prime: 4e-5 },
  { q: 3e-4, eps: 0.03, s: 1, eps_prime: 1e-4 },
  { q: 3e-4, eps: 0.03, s: 0.6, eps_prime: 1e-4 },
];

const log = JSON.parse(
  await readFile(new URL("./lesson-session.json", import.meta.url), "utf8"),
) as { events: IdeaEvent[] };
const t = IdeaTree.replay(log.events);
for (const run of t.runsToConfirm()) {
  const spec = t.nodes.get(run.node)?.check;
  if (spec) t.confirm(run.seq, runCheck(spec, { ...t.scope(), ...(run.result.inputs ?? {}) }));
}
const first = t.lessons[0];
const node = first && t.nodes.get(first.node);
const spec = node?.check;
if (!first || !node || spec?.kind !== "oregonator") throw new Error("no lesson to continue");

const muse = new Muse(
  process.env.MUSE_API_KEY ? { apiKey: process.env.MUSE_API_KEY } : {},
  new Ledger(1),
);

for (const point of CANDIDATES) {
  for (const k of SIM_PARAMS) {
    if (t.scope()[k] !== point[k])
      t.append("person", { type: "set_param", name: k, value: point[k], source: "evaluation" });
  }
  const inputs = Object.fromEntries(SIM_PARAMS.map((k) => [k, t.scope()[k] ?? NaN]));
  const pr = await muse.ask(
    {
      instructions: PREDICT,
      input: JSON.stringify({
        assumption: node.statement,
        question: spec.question,
        tolerance: spec.tolerance,
        values: inputs,
        lessons: t.lessonsForModel(node.id),
      }),
      mode: "standard",
      effort: "low",
      maxOutput: 4000,
    },
    "prediction",
    PREDICT_SCHEMA,
  );
  const pv = pr.value as { expect: Outcome; confidence: number; reason: string; uses: string[] };
  const pid = `p${String(t.predictions.length + 1)}`;
  t.append(`muse:${pr.usage.model}`, {
    type: "predict",
    id: pid,
    node: node.id,
    inputs,
    ...pv,
    usage: pr.usage,
  });
  const result = runCheck(spec, t.scope());
  const run = t.append("engine", { type: "check", node: node.id, result });
  t.confirm(run.seq, result);
  if ("error" in result) throw new Error(result.error);
  const observed: Outcome = result.pass ? "holds" : "fails";
  console.log(
    `${JSON.stringify(point)}: Muse ${pv.expect} (${String(pv.confidence)}), run ${observed} (gap ${result.value.toFixed(4)})`,
  );
  if (observed === pv.expect) continue;
  const dg = await muse.ask(
    {
      instructions: DIAGNOSE,
      input: JSON.stringify({
        assumption: node.statement,
        question: spec.question,
        tolerance: spec.tolerance,
        values: inputs,
        predicted: { expect: pv.expect, confidence: pv.confidence, reason: pv.reason },
        observed,
        measured: {
          ...result.sim?.periods,
          relative_difference: result.value,
          definition: "|full - reduced| / reduced",
        },
        lessons: t.lessonsForModel(node.id),
      }),
      mode: "standard",
      effort: "medium",
      maxOutput: 8000,
    },
    "diagnosis",
    DIAGNOSE_SCHEMA,
  );
  const dv = dg.value as {
    candidates: { explanation: string; scope: string; expect: Outcome }[];
    test: { param: string; value: number };
    open: string;
  };
  const hid = `lesson-${String(t.lessons.length + 1)}`;
  t.append(`muse:${dg.usage.model}`, {
    type: "hypotheses",
    id: hid,
    prediction: pid,
    candidates: dv.candidates.slice(0, 2),
    test: dv.test,
    open: dv.open,
    usage: dg.usage,
  });
  const lesson = t.lessons.find((l) => l.id === hid);
  if (!lesson) throw new Error("the hypotheses were not recorded");
  const r = runCheck(spec, t.testScope(lesson));
  const tested = t.append("engine", { type: "test", hypotheses: hid, result: r });
  t.confirm(tested.seq, r);
  console.log(JSON.stringify({ test: dv.test, candidates: dv.candidates, result: r }, null, 1));
  console.log(`state ${t.lessonState(lesson)}, cost $${muse.ledger.total.toFixed(4)}`);
  await writeFile(out, JSON.stringify({ format: "vibloom-ideas-1", events: t.events }, null, 1));
  process.exit(0);
}
console.log("no candidate surprised Muse; nothing written");
process.exit(1);
