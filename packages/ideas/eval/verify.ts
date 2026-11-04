// Checks the recorded sessions without a browser or a key: replays each log
// (every hash and every formula is verified on the way), runs every recorded
// experiment again with the solver, and prints what the session claims next
// to what was reproduced here.
//
//   npm run verify

import { readFile } from "node:fs/promises";
import { runCheck } from "../src/check";
import { IdeaTree } from "../src/tree";
import type { IdeaEvent, Refusal } from "../src/types";

const dir = new URL("../../../apps/web/public/examples/", import.meta.url);
const SESSIONS = ["chemical-clock", "period-reduction", "cardboard-airliner"];
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
let failures = 0;

for (const name of SESSIONS) {
  const data = JSON.parse(await readFile(new URL(`${name}.json`, dir), "utf8")) as {
    events: IdeaEvent[];
    refused?: Refusal[];
  };
  const t = IdeaTree.replay(data.events);
  console.log(`\n${name}: ${String(data.events.length)} events, hash chain verified`);
  console.log(`  goal: ${t.goal.split("\n")[0] ?? ""}`);
  const started = Date.now();
  for (const run of t.runs) {
    const spec = t.nodes.get(run.node)?.check;
    if (!spec) continue;
    const l = run.purpose === "test" ? t.lessons.find((x) => x.run === run.seq) : undefined;
    t.confirm(
      run.seq,
      runCheck(spec, l ? t.testScope(l) : { ...t.scope(), ...(run.result.inputs ?? {}) }),
    );
    const r = run.result;
    const said = "error" in r ? r.error : `${r.pass ? "holds" : "fails"} (gap ${pct(r.value)})`;
    const ok = run.state === "confirmed";
    if (!ok) failures++;
    console.log(
      `  #${String(run.seq)} ${run.purpose} ${run.node}: recorded ${said}; ${ok ? "reproduced" : "DID NOT REPRODUCE"}`,
    );
  }
  for (const p of t.predictions) {
    const v = t.verdict(p.run);
    console.log(
      `  prediction ${p.id} on ${p.node}: ${p.expect} (${pct(p.confidence)}), ${p.blind ? "blind" : "NOT blind"}; run says ${String(v)}`,
    );
  }
  for (const l of t.lessons) {
    const d = t.decided(l);
    console.log(
      `  lesson ${l.id}: ${t.lessonState(l)}; test ${l.test.param} = ${String(l.test.value)} (${l.intervention} change)` +
        (d
          ? `; consistent with ${d.supported ? "B" : "A"}: ${l.candidates[d.supported]?.explanation ?? ""}`
          : ""),
    );
  }
  const formulas = data.events.filter(
    (e) => e.body.type === "check" && !t.runs.some((r) => r.seq === e.seq),
  ).length;
  console.log(`  ${String(formulas)} formula checks recomputed by the engine during replay`);
  const c = t.calibration();
  const cost = data.events.reduce((s, e) => s + ("usage" in e.body ? e.body.usage.cost : 0), 0);
  console.log(
    `  scored predictions ${String(c.made)}, right ${String(c.right)}; refused attempts ${String(data.refused?.length ?? 0)}; Muse cost when recorded $${cost.toFixed(3)}; re-run in ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
}

console.log(
  failures ? `\n${String(failures)} run(s) did not reproduce` : "\nEvery run reproduced.",
);
process.exitCode = failures ? 1 : 0;
