import { describe, expect, it } from "vitest";
import { nextEntry, readLog, type RunEntry } from "./log.ts";

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
