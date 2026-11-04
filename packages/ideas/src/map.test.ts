import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runCheck } from "./check";
import { axis, cellScope, mapSetup, recenter, runCell, verdict } from "./map";
import { IdeaTree } from "./tree";
import type { IdeaEvent } from "./types";
import type { GrownNode } from "./protocol";

const session = async () => {
  const url = new URL("../../../apps/web/public/examples/chemical-clock.json", import.meta.url);
  const data = JSON.parse(await readFile(url, "utf8")) as { events: IdeaEvent[] };
  return IdeaTree.replay(data.events);
};

describe("the recipe map", () => {
  it("puts the current value in the middle of each axis", () => {
    const a = axis(0.2);
    expect(a).toHaveLength(7);
    expect(a[3]).toBe(0.2);
    expect(a[0]).toBeCloseTo(0.02);
    expect(a[6]).toBeCloseTo(2);
  });

  it("reproduces the recorded run at the tree's own recipe", async () => {
    const t = await session();
    const setup = mapSetup(t);
    if (typeof setup === "string") throw new Error(setup);
    expect(setup.node.id).toBe("reduction-keeps");
    expect(setup.target?.id).toBe("period-hits-target");
    expect(setup.held.acid).toBe(0.8);
    const run = runCell(t, setup, setup.recipe);
    const recorded = t.results.get(setup.node.id);
    if (!recorded || "error" in recorded || "error" in run) throw new Error("no run");
    // Recorded in a browser; Node and Chromium agree to about 1e-5 here.
    expect(Math.abs(run.value - recorded.value) / recorded.value).toBeLessThan(1e-4);
    const v = verdict(t, setup, setup.recipe, run);
    // At 0.2 M malonic acid the clock hits 60 s +/- 10 but the models disagree.
    expect(v.periodS).toBeCloseTo(66.8, 0);
    expect(v.meetsTarget).toBe(true);
    expect(v.concordant).toBe(false);
  }, 60000);

  it("re-derives every model parameter from the changed recipe", async () => {
    const t = await session();
    const setup = mapSetup(t);
    if (typeof setup === "string") throw new Error(setup);
    const here = cellScope(t, setup.recipe);
    const more = cellScope(t, { ...setup.recipe, bromate: setup.recipe.bromate * 2 });
    expect(more.eps).toBeCloseTo((here.eps ?? NaN) / 2);
    expect(more.q).toBeCloseTo(here.q ?? NaN);
  });

  it("zooms in when re-centred and checks the tree's other recipe limits per cell", async () => {
    const t = await session();
    const setup = mapSetup(t);
    if (typeof setup === "string") throw new Error(setup);
    const closer = recenter(setup, { ...setup.recipe, bromate: 0.24 });
    expect(closer.span).toBeCloseTo(Math.sqrt(10));
    expect(closer.axes.bromate[3]).toBe(0.24);
    // A limit Muse could write: stay within 0.1 M bromate.
    const limit: GrownNode = {
      key: "bromate-limit",
      title: "Bromate stays low",
      statement: "",
      axis: "requirements",
      role: "assumption",
      criticality: "major",
      risk: "low",
      rationale: "",
      params: [],
      check: { description: "", value: "bromate", op: "<=", limit: "0.1", unit: "M" },
      basis: [],
    };
    const nodes = t.admit("goal", [limit]);
    t.append("muse", {
      type: "grow",
      under: "goal",
      nodes,
      summary: "",
      usage: { model: "m", input: 0, cached: 0, output: 0, reasoning: 0, cost: 0 },
    });
    const s2 = mapSetup(t);
    if (typeof s2 === "string") throw new Error(s2);
    const high = { ...s2.recipe, bromate: 0.24 };
    const v = verdict(t, s2, high, runCell(t, s2, high));
    expect(v.others.find((o) => o.node === "bromate-limit")?.result).toMatchObject({ pass: false });
  }, 60000);

  it("treats a recipe chosen from the map as already computed", async () => {
    const t = await session();
    const setup = mapSetup(t);
    if (typeof setup === "string") throw new Error(setup);
    const pick = { ...setup.recipe, bromate: 0.3 };
    const run = runCell(t, setup, pick);
    t.append("person", { type: "set_param", name: "bromate", value: 0.3, source: "recipe map" });
    t.append("engine", { type: "check", node: setup.node.id, result: run, via: "map" });
    // The reduction run settles the full model's question too: not blind.
    const full = t.nodes.get("full-oscillates")?.check;
    if (!full) throw new Error("missing");
    const inputs = Object.fromEntries(
      ["s", "q", "eps", "eps_prime"].map((k) => [k, t.scope()[k] ?? NaN]),
    );
    // The app runs it without asking Muse: the map's run settles it.
    expect(t.settledBy("full-oscillates", inputs)?.seq).toBe(t.events.length - 1);
    t.append("muse", {
      type: "predict",
      id: "p-map",
      node: "full-oscillates",
      inputs,
      expect: "holds",
      confidence: 0.8,
      reason: "",
      uses: [],
      usage: { model: "m", input: 0, cached: 0, output: 0, reasoning: 0, cost: 0 },
    });
    expect(t.predictions.find((p) => p.id === "p-map")?.blind).toBe(false);
    expect(runCheck(full, t.scope())).toBeDefined();
  }, 60000);
});
