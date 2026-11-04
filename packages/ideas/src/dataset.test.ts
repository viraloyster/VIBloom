import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { build, jsonl, mismatches } from "../eval/dataset";

const root = new URL("../../../", import.meta.url);

describe("the evaluation dataset", () => {
  it("matches every count and score in docs/evaluation.md", async () => {
    const d = await build(root);
    expect(mismatches(d.counts)).toEqual([]);
    expect(d.predictions).toHaveLength(604);
    expect(d.points).toHaveLength(106);
  });

  it("is committed as built, with every prediction pointing at a point", async () => {
    const d = await build(root);
    const dir = new URL("docs/eval/dataset/", root);
    expect(await readFile(new URL("points.jsonl", dir), "utf8")).toBe(jsonl(d.points));
    expect(await readFile(new URL("predictions.jsonl", dir), "utf8")).toBe(jsonl(d.predictions));
    const ids = new Set(d.points.map((p) => p.point));
    expect(ids.size).toBe(d.points.length);
    expect(d.predictions.every((p) => ids.has(p.point))).toBe(true);
  });
});
