import { describe, expect, it } from "vitest";
import { extendsLog, nextEntry, readLog, type RunEntry } from "./log.ts";

const body = (status: "pass" | "fail") => ({
  at: "2026-11-13T00:00:00.000Z",
  command: ["forge", "test", "--json"],
  outcomes: [{ file: "t.sol", contract: "T", name: "invariant_a", status }],
  files: { "src/A.sol": "abc" },
});

const chain = (): RunEntry[] => {
  const a = nextEntry(undefined, body("fail"));
  const b = nextEntry(a, body("pass"));
  return [a, b];
};

const text = (es: RunEntry[]) => es.map((e) => JSON.stringify(e)).join("\n");

describe("run log", () => {
  it("reads back an intact chain", () => {
    const es = chain();
    expect(readLog(text(es))).toEqual({ entries: es, problems: [] });
  });

  it("stops trusting the log at an entry changed after it was written", () => {
    const es = chain();
    const forged = es[0]!.outcomes[0]!;
    forged.status = "pass";
    const r = readLog(text(es));
    expect(r.entries).toEqual([]);
    expect(r.problems).toEqual([
      "entry 1 was changed after it was written",
      "1 entry after it ignored",
    ]);
  });

  it("detects a removed entry", () => {
    const es = chain();
    const r = readLog(text([es[1]!]));
    expect(r.entries).toEqual([]);
    expect(r.problems[0]).toMatch(/does not follow/);
  });

  it("detects a forged entry with a recomputed hash but a broken link", () => {
    const [a, b] = chain();
    const fake = nextEntry(undefined, body("pass"));
    const r = readLog(text([a!, { ...b!, prev: fake.hash }]));
    expect(r.entries).toEqual([a]);
    expect(r.problems[0]).toMatch(/does not follow/);
  });
});

describe("extendsLog", () => {
  it("accepts a branch that only added runs", () => {
    const [a, b] = chain();
    expect(extendsLog([a!], [a!, b!])).toEqual([]);
    expect(extendsLog([], [a!])).toEqual([]);
  });

  it("rejects a log regenerated from scratch, even with a valid chain of its own", () => {
    const [a] = chain();
    const regenerated = nextEntry(undefined, { ...body("pass"), at: "2026-11-14T00:00:00.000Z" });
    expect(readLog(text([regenerated])).problems).toEqual([]);
    expect(extendsLog([a!], [regenerated])).toEqual([
      "run 1 differs from the base: the log was rewritten, not extended",
    ]);
  });

  it("rejects a log that lost runs", () => {
    const [a, b] = chain();
    expect(extendsLog([a!, b!], [a!])).toEqual([
      "the log has 1 runs, fewer than the 2 on the base",
    ]);
  });
});
