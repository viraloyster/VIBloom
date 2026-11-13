import { describe, expect, it } from "vitest";
import type { NodeView } from "./derive.ts";
import { precommit } from "./gate.ts";
import { parseMap, type RootsMap } from "./map.ts";

const map = (): RootsMap => {
  const r = parseMap({
    version: 1,
    nodes: [
      {
        id: "inv.sum",
        kind: "invariant",
        title: "sum",
        test: { file: "test/C.t.sol", name: "invariant_sum" },
        watch: ["src/C.sol"],
      },
    ],
  });
  if (!r.ok) throw new Error(r.errors.join());
  return r.map;
};

const view = (over: Partial<NodeView> = {}): NodeView => ({
  id: "inv.sum",
  kind: "invariant",
  title: "sum",
  stance: "adopted",
  protected: true,
  evidence: "holds",
  support: "ok",
  because: [],
  changed: [],
  dependsOn: [],
  watch: ["src/C.sol", "test/C.t.sol"],
  testFile: "test/C.t.sol",
  run: 3,
  ...over,
});

describe("precommit", () => {
  it("passes a commit of code whose invariants hold, with the new run log", () => {
    expect(precommit(map(), [view()], ["src/C.sol", ".vibloom/log.jsonl"], "builder", [])).toEqual({
      ok: true,
      problems: [],
    });
  });

  it("refuses guarded files from anyone but the verifier", () => {
    const staged = ["test/C.t.sol", ".vibloom/roots.json"];
    const r = precommit(map(), [view()], staged, "builder", []);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      "test/C.t.sol is guarded: only VIBLOOM_ROLE=verifier may commit changes to it",
      ".vibloom/roots.json is guarded: only VIBLOOM_ROLE=verifier may commit changes to it",
    ]);
    expect(precommit(map(), [view()], staged, "verifier", []).ok).toBe(true);
  });

  it("refuses code that was not tested after it changed, or that broke something", () => {
    const stale = precommit(
      map(),
      [view({ evidence: "stale", changed: ["src/C.sol"] })],
      ["src/C.sol"],
      "builder",
      [],
    );
    expect(stale.problems).toEqual([
      "inv.sum [pending review] sum; changed since run 3: src/C.sol",
    ]);
    const broken = precommit(
      map(),
      [view({ evidence: "broken", reason: "drift" })],
      [],
      "verifier",
      [],
    );
    expect(broken.problems).toEqual(["inv.sum [BROKEN] sum; failure: drift"]);
  });

  it("refuses an invariant that has never run", () => {
    expect(precommit(map(), [view({ evidence: "untested" })], [], "builder", []).problems).toEqual([
      "inv.sum [untested] sum",
    ]);
  });

  it("refuses a tampered log even for the verifier", () => {
    const r = precommit(map(), [view()], [], "verifier", [
      "entry 2 was changed after it was written",
    ]);
    expect(r.problems).toEqual(["run log: entry 2 was changed after it was written"]);
  });
});
