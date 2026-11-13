import { describe, expect, it } from "vitest";
import { derive, label, troubled } from "./derive.ts";
import type { OutcomeStatus } from "./forge.ts";
import { nextEntry, type RunEntry } from "./log.ts";
import { parseMap, type RootsMap } from "./map.ts";

const map = (): RootsMap => {
  const r = parseMap({
    version: 1,
    nodes: [
      {
        id: "inv.sum",
        kind: "invariant",
        title: "total is the sum of parts",
        test: { file: "test/C.t.sol", contract: "CT", name: "invariant_sum" },
        watch: ["src/"],
      },
      {
        id: "inv.bound",
        kind: "invariant",
        title: "total is bounded",
        test: { file: "test/C.t.sol", name: "invariant_bound" },
      },
      {
        id: "asm.only-add",
        kind: "assumption",
        title: "only add moves total",
        depends_on: ["inv.sum"],
      },
      {
        id: "int.exact",
        kind: "intention",
        title: "accounting is exact",
        depends_on: ["asm.only-add", "inv.bound"],
      },
      { id: "asm.off", kind: "assumption", title: "switched off", stance: "off" },
      {
        id: "int.uses-off",
        kind: "intention",
        title: "rests on an off node",
        depends_on: ["asm.off"],
      },
    ],
  });
  if (!r.ok) throw new Error(r.errors.join());
  return r.map;
};

const files = { "src/C.sol": "h1", "src/Lib.sol": "h2", "test/C.t.sol": "t1" };

const outcome = (name: string, status: OutcomeStatus) =>
  status === "fail"
    ? { file: "test/C.t.sol", contract: "CT", name, status, reason: "drift" }
    : { file: "test/C.t.sol", contract: "CT", name, status };

const entry = (
  last: RunEntry | undefined,
  sum: OutcomeStatus,
  bound: OutcomeStatus,
  recorded: Record<string, string | null> = files,
): RunEntry =>
  nextEntry(last, {
    at: "2026-11-13T00:00:00.000Z",
    command: ["forge", "test", "--json"],
    outcomes: [outcome("invariant_sum", sum), outcome("invariant_bound", bound)],
    files: recorded,
  });

const byId = (vs: ReturnType<typeof derive>) => Object.fromEntries(vs.map((v) => [v.id, v]));

describe("derive", () => {
  it("starts untested, with off nodes reported as a choice", () => {
    const v = byId(derive(map(), [], files));
    expect(label(v["inv.sum"]!)).toBe("untested");
    expect(label(v["asm.only-add"]!)).toBe("hypothetical");
    expect(label(v["asm.off"]!)).toBe("off");
    expect(label(v["int.uses-off"]!)).toBe("AT RISK");
    expect(troubled(v["asm.off"]!)).toBe(false);
  });

  it("propagates a broken invariant up through assumptions to intentions", () => {
    const v = byId(derive(map(), [entry(undefined, "fail", "pass")], files));
    expect(v["inv.sum"]).toMatchObject({ evidence: "broken", reason: "drift", run: 1 });
    expect(v["asm.only-add"]).toMatchObject({ support: "unsupported", because: ["inv.sum"] });
    expect(v["int.exact"]).toMatchObject({ support: "unsupported", because: ["asm.only-add"] });
    expect(label(v["int.exact"]!)).toBe("AT RISK");
    expect(v["inv.bound"]!.evidence).toBe("holds");
  });

  it("puts a pass up for review when a watched file changes, including files added to a watched directory", () => {
    const e = entry(undefined, "pass", "pass");
    const edited = byId(derive(map(), [e], { ...files, "src/C.sol": "h1-edited" }));
    expect(edited["inv.sum"]).toMatchObject({ evidence: "stale", changed: ["src/C.sol"] });
    expect(edited["asm.only-add"]!.support).toBe("pending");
    expect(edited["inv.bound"]!.evidence).toBe("holds");

    const added = byId(derive(map(), [e], { ...files, "src/New.sol": "n" }));
    expect(added["inv.sum"]).toMatchObject({ evidence: "stale", changed: ["src/New.sol"] });

    const removed = byId(derive(map(), [e], { "src/C.sol": "h1", "test/C.t.sol": "t1" }));
    expect(removed["inv.sum"]).toMatchObject({ evidence: "stale", changed: ["src/Lib.sol"] });
  });

  it("keeps a failure broken until a newer run passes, and uses the latest run for each test", () => {
    const a = entry(undefined, "fail", "pass");
    const stillBroken = byId(derive(map(), [a], { ...files, "src/C.sol": "fixed" }));
    expect(stillBroken["inv.sum"]!.evidence).toBe("broken");

    const b = entry(a, "pass", "pass", { ...files, "src/C.sol": "fixed" });
    const fixed = byId(derive(map(), [a, b], { ...files, "src/C.sol": "fixed" }));
    expect(fixed["inv.sum"]).toMatchObject({ evidence: "holds", run: 2 });
    expect(fixed["int.exact"]!.support).toBe("ok");
  });

  it("does not match a result from another contract with the same test name", () => {
    const other = nextEntry(undefined, {
      at: "2026-11-13T00:00:00.000Z",
      command: ["forge"],
      outcomes: [
        { file: "test/C.t.sol", contract: "Other", name: "invariant_sum", status: "pass" },
      ],
      files,
    });
    expect(byId(derive(map(), [other], files))["inv.sum"]!.evidence).toBe("untested");
  });
});
