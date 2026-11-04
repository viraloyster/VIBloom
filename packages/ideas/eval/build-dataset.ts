// Writes the evaluations as an open dataset in docs/eval/dataset/, or with
// "check" verifies the committed files, failing on any difference.
//
//   npm run dataset
//   npm run dataset -- check

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build, jsonl, mismatches } from "./dataset";

const root = new URL("../../../", import.meta.url);
const d = await build(root);
const bad = mismatches(d.counts);
if (bad.length) {
  console.error(bad.join("\n"));
  process.exit(1);
}
const dir = new URL("docs/eval/dataset/", root);
const files = {
  "protocols.json": JSON.stringify(d.protocols, null, 1) + "\n",
  "points.jsonl": jsonl(d.points),
  "predictions.jsonl": jsonl(d.predictions),
};
if (process.argv.includes("check")) {
  for (const [name, text] of Object.entries(files)) {
    const have = await readFile(new URL(name, dir), "utf8").catch(() => "");
    if (have !== text) {
      console.error(`${name} is out of date; run npm run dataset`);
      process.exit(1);
    }
  }
  console.log("dataset matches the evaluations");
} else {
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(new URL(name, dir), text);
  console.log(
    `${String(d.points.length)} points, ${String(d.predictions.length)} predictions, ${String(d.protocols.length)} protocols; counts match docs/evaluation.md`,
  );
}
