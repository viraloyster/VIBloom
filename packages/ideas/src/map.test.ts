import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { recipeEffects, runCheck, SIM_PARAMS } from "./check";
import { axis, cellScope, mapRecord, mapSetup, recenter, replayMap, runCell, verdict } from "./map";
import { EXPERIMENT_TOLERANCE } from "./tree";
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
    // The app runs it without asking Muse: a run at these values settles it.
    // Here the first is the recorded lesson's test, which ran 0.3 M bromate.
    expect(t.settledBy("full-oscillates", inputs)?.purpose).toBe("test");
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

  it("states which way each recipe change moves the model, from the conversion", () => {
    const e = recipeEffects({ bromate: 0.06, malonic_acid: 0.02, acid: 0.8, s: 1 });
    // q is proportional to [H+]; eps falls with it.
    expect(e["raising acid"]).toMatchObject({ q: "up", eps: "down", time_scale_s: "same" });
    expect(e["raising bromate"]).toMatchObject({ q: "same", eps: "down", eps_prime: "down" });
    expect(e["raising malonic_acid"]).toMatchObject({ eps: "up", time_scale_s: "down" });
  });

  it("records a map in the log and finds a cell whose record was altered", async () => {
    const t = await session();
    const setup = mapSetup(t);
    if (typeof setup === "string") throw new Error(setup);
    // Two cells keep the test short; a recorded map holds all 49.
    const recipes = [setup.recipe, { ...setup.recipe, bromate: setup.axes.bromate[4] ?? NaN }];
    const cells = recipes.map((recipe) => {
      const run = runCell(t, setup, recipe);
      return { recipe, run, v: verdict(t, setup, recipe, run) };
    });
    const above = {
      recipe: { ...setup.recipe, bromate: setup.axes.bromate[6] ?? NaN },
      excluded: true,
    };
    const body = mapRecord(setup, [...cells, above], 1);
    const before = t.events.length;
    t.append("engine", body);
    const replayed = IdeaTree.replay(t.events);
    expect(replayed.maps).toHaveLength(1);
    const then = IdeaTree.replay(t.events.slice(0, before));
    expect(replayMap(then, body, EXPERIMENT_TOLERANCE)).toEqual([]);
    const bent = structuredClone(body);
    const first = bent.cells[0];
    if (first) first.concordant = !first.concordant;
    expect(replayMap(then, bent, EXPERIMENT_TOLERANCE)).toHaveLength(1);
    // A cell off the map's axes is refused by the log.
    const off = structuredClone(body);
    if (off.cells[0]) off.cells[0].bromate = 123;
    expect(() => t.append("engine", off)).toThrow(/off its axes/);
  }, 60000);
});

describe("the runs a routed answer is given", () => {
  // Thirty runs on the same experiment root, each at its own bromate, with
  // the result shape a real run has: model inputs, no recipe.
  const many = async () => {
    const t = await session();
    const node = [...t.nodes.values()].find(
      (n) => n.check?.kind === "oregonator" && n.check.question === "reduction_keeps_period",
    );
    const base = node ? t.latestRun(node.id)?.result : undefined;
    if (!node || !base || "error" in base) throw new Error("no run");
    for (let i = 1; i <= 30; i++) {
      t.append("person", {
        type: "set_param",
        name: "bromate",
        value: 0.1 + i / 1000,
        source: "test",
      });
      const scope = t.scope();
      const inputs = Object.fromEntries(
        [...SIM_PARAMS, "time_scale_s", "recipe_version"].map((k) => [k, scope[k] ?? NaN]),
      );
      t.append("engine", { type: "check", node: node.id, result: { ...base, inputs } });
    }
    return { t, node };
  };

  it("keeps the run a question names, even behind 30 on the root asked about", async () => {
    const { t, node } = await many();
    expect(t.runs.at(-1)?.result.inputs?.bromate).toBeUndefined();
    const asked = t.runIndex([node.id], "What did the run at bromate 0.101 M give?", 24);
    expect(asked.runs).toHaveLength(24);
    expect(asked.omitted).toBe(t.runs.length - 24);
    expect(asked.named_values_found).toBe(true);
    const first = asked.runs.find((r) => r.recipe?.bromate === 0.101);
    expect(first?.current).toBe("superseded by a later run");
    expect(first?.reproduced_here).toBe("unconfirmed");
    // Without the value, the root's 24 latest runs fill the index.
    const plain = t.runIndex([node.id], "What happened?", 24);
    expect(plain.runs.some((r) => r.recipe?.bromate === 0.101)).toBe(false);
    expect(plain.runs.every((r) => r.node === node.id)).toBe(true);
    // A value no run has: the record says so.
    expect(t.runIndex([node.id], "And at bromate 0.5 M?", 24).named_values_found).toBe(false);
    // Replayed, the runs keep their recipes.
    expect(IdeaTree.replay(t.events).runs.some((r) => r.recipe?.bromate === 0.101)).toBe(true);
  });

  it("does not count a prediction as blind where a recorded map already ran", async () => {
    const t = await session();
    const setup = mapSetup(t);
    if (typeof setup === "string") throw new Error(setup);
    const recipe = { ...setup.recipe, bromate: setup.axes.bromate[5] ?? NaN };
    const run = runCell(t, setup, recipe);
    t.append(
      "engine",
      mapRecord(setup, [{ recipe, run, v: verdict(t, setup, recipe, run) }], undefined),
    );
    const mapSeq = t.events.length - 1;
    // Another way to the same cell: the person sets the recipe by hand.
    t.append("person", {
      type: "set_param",
      name: "bromate",
      value: recipe.bromate,
      source: "test",
    });
    const id = [...t.nodes.values()].find((n) => n.check?.kind === "oregonator")?.id ?? "";
    const scope = t.scope();
    const inputs = Object.fromEntries(SIM_PARAMS.map((k) => [k, scope[k] ?? NaN]));
    expect(t.settledBy(id, inputs)).toEqual({ seq: mapSeq, purpose: "map" });
    t.append("muse", {
      type: "predict",
      id: "after-map",
      node: id,
      inputs: scope,
      expect: "holds",
      confidence: 0.7,
      reason: "",
      uses: [],
      usage: { model: "m", input: 0, cached: 0, output: 0, reasoning: 0, cost: 0 },
    });
    expect(t.predictions.find((p) => p.id === "after-map")?.blind).toBe(false);
  }, 60000);
});
