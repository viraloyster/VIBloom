import { describe, expect, it } from "vitest";
import { runCheck, SIM_PARAMS, thresholds } from "./check";
import { BudgetExceeded, cost, Ledger } from "./cost";
import { evaluate } from "./expr";
import { Muse } from "./muse";
import type { GrownNode } from "./protocol";
import { unsupportedNumbers } from "./numbers";
import { ArrayItems } from "./stream";
import { IdeaTree } from "./tree";
import type { IdeaEvent, Usage } from "./types";

const noCheck = { description: "", value: "", op: "none", limit: "", unit: "" };
const grown = (key: string, extra: Partial<GrownNode> = {}): GrownNode => ({
  key,
  title: `T ${key}`,
  statement: `S ${key}`,
  axis: "loads",
  role: "assumption",
  criticality: "critical",
  risk: "high",
  rationale: "",
  params: [],
  check: noCheck,
  basis: [],
  ...extra,
});
const usage: Usage = {
  model: "muse-spark-1.3",
  input: 1,
  cached: 0,
  output: 1,
  reasoning: 0,
  cost: 0,
};
const seqOf = (t: IdeaTree, id: string) => t.latestRun(id)?.seq ?? -1;
const p = (name: string, value: number, origin = "assumed", unit = "MPa") => ({
  name,
  value,
  unit,
  origin,
  source: origin === "reference" ? "Roark" : "ignored",
});

function planted() {
  const t = new IdeaTree();
  t.append("person", { type: "goal", text: "Cardboard airliner", mode: "standard" });
  const nodes = t.admit("goal", [
    grown("skin", {
      params: [p("stress need", 55, "reference"), p("strength", 12)],
      check: {
        description: "hoop stress against strength",
        value: "stress_need",
        op: "<=",
        limit: "strength",
        unit: "MPa",
      },
    }),
    grown("cost", { risk: "low", basis: ["skin", "nowhere"] }),
  ]);
  t.append("muse", { type: "grow", under: "goal", nodes, summary: "", usage });
  return t;
}

const run = (t: IdeaTree, id: string) => {
  const spec = t.nodes.get(id)?.check;
  if (!spec) throw new Error("no check");
  t.append("engine", { type: "check", node: id, result: runCheck(spec, t.scope()) });
};

describe("arithmetic checks", () => {
  it("evaluates expressions over named parameters and records what they read", () => {
    const read: Record<string, number> = {};
    expect(evaluate("delta_p * r / t + 2^3 - -1", { delta_p: 60, r: 2, t: 0.01, z: 9 }, read)).toBe(
      12009,
    );
    expect(read).toEqual({ delta_p: 60, r: 2, t: 0.01 });
    expect(evaluate("sqrt(max(4, 9)) * pi", {})).toBeCloseTo(3 * Math.PI);
    expect(evaluate("p.a * 2", { a: 3 })).toBe(6);
  });

  it("refuses anything that is not arithmetic", () => {
    for (const bad of ["fetch('x')", "a; b", "constructor", "this.x", "a[0]", "`x`", "a = 1"]) {
      expect(() => evaluate(bad, { a: 1, b: 2 })).toThrow();
    }
  });

  it("decides pass from the comparison, never from the model", () => {
    const spec = { description: "", value: "a", op: "<=" as const, limit: "b", unit: "" };
    expect(runCheck(spec, { a: 1, b: 2 })).toMatchObject({ pass: true, value: 1, limit: 2 });
    expect(runCheck({ ...spec, op: ">" }, { a: 1, b: 2 })).toMatchObject({ pass: false });
    expect(runCheck({ ...spec, value: "a / 0" }, { a: 1, b: 2 })).toHaveProperty("error");
    expect(runCheck({ ...spec, value: "missing" }, { a: 1, b: 2 })).toHaveProperty("error");
  });
});

describe("thresholds", () => {
  it("finds where each value would flip the verdict, computed by the engine", () => {
    const spec = {
      description: "",
      value: "load / area",
      op: "<=" as const,
      limit: "strength",
      unit: "",
    };
    const scope = { load: 120, area: 1, strength: 2 };
    const [load, area, strength] = thresholds(spec, scope, ["load", "area", "strength"]);
    expect(load?.at).toBeCloseTo(2, 6);
    expect(load?.holdsWhen).toBe("below");
    expect(area?.at).toBeCloseTo(60, 4);
    expect(area?.holdsWhen).toBe("above");
    expect(strength?.at).toBeCloseTo(120, 4);
    expect(strength?.holdsWhen).toBe("above");
  });

  it("says when no single threshold exists, and stops at singularities", () => {
    const band = {
      description: "",
      value: "(x - 1) * (x - 3)",
      op: "<=" as const,
      limit: "0",
      unit: "",
    };
    const [x] = thresholds(band, { x: 4 }, ["x"]);
    expect(x?.at).toBeCloseTo(3, 5);
    expect(x?.single).toBe(false);
    const pole = { description: "", value: "1 / (x - 2)", op: "<=" as const, limit: "0", unit: "" };
    expect(thresholds(pole, { x: 3 }, ["x"])[0]?.at).toBeUndefined();
  });

  it("reports no flip when none exists within four orders of magnitude", () => {
    const spec = { description: "", value: "a", op: "<=" as const, limit: "1e9", unit: "" };
    expect(thresholds(spec, { a: 1 }, ["a"])[0]?.at).toBeUndefined();
  });
});

describe("idea tree", () => {
  it("admits model output only on protocol, with clean names and resolved basis", () => {
    const t = planted();
    const skin = t.nodes.get("skin");
    expect(skin?.params.map((x) => x.name)).toEqual(["stress_need", "strength"]);
    // An assumed value never keeps a source.
    expect(skin?.params[1]?.source).toBe("");
    expect(t.nodes.get("cost")?.basis).toEqual(["skin"]);
    expect(t.nodes.get("cost")?.check).toBeUndefined();
    expect(t.admit("goal", [{ ...grown("bad"), axis: "astrology" }])).toEqual([]);
  });

  it("derives red from a computation, and marks what rests on it", () => {
    const t = planted();
    run(t, "skin");
    expect(t.status("skin")).toBe("broken");
    expect(t.status("cost")).toBe("affected");
    expect(t.status("goal")).toBe("affected");
    expect(t.assumedInputs("skin").map((x) => x.name)).toEqual(["strength"]);
  });

  it("never copies an existing parameter: a deeper node uses it or suggests a value", () => {
    const t = planted();
    run(t, "skin");
    const under = t.admit("skin", [
      grown("liner", { params: [p("strength", 8, "reference"), p("liner_plies", 3)] }),
      grown("same", { params: [p("strength", 12)] }),
    ]);
    t.append("muse", { type: "grow", under: "skin", nodes: under, summary: "", usage });
    const liner = t.nodes.get("skin.liner");
    expect(liner?.params.map((x) => x.name)).toEqual(["liner_plies"]);
    expect(liner?.uses).toEqual(["strength"]);
    expect(liner?.suggestions.map((x) => x.value)).toEqual([8]);
    expect(t.nodes.get("skin.same")?.suggestions).toEqual([]);
    expect(t.owner("strength")?.id).toBe("skin");
    // Adopting the deeper value changes the one parameter the parent reads.
    t.append("person", { type: "set_param", name: "strength", value: 60, source: "adopted" });
    expect(t.status("skin")).toBe("stale");
    run(t, "skin");
    // It passes, but its new premises are only argued: backing incomplete.
    expect(t.status("skin")).toBe("partial");
  });

  it("refuses a log that defines a parameter twice", () => {
    const t = planted();
    const copy = structuredClone(t.nodes.get("skin"));
    if (!copy) throw new Error("missing");
    expect(() =>
      t.append("muse", {
        type: "grow",
        under: "skin",
        nodes: [{ ...copy, id: "skin.copy", parent: "skin" }],
        summary: "",
        usage,
      }),
    ).toThrow(/already exists/);
  });

  it("replays its own log and refuses a tampered one", () => {
    const t = planted();
    run(t, "skin");
    t.append("person", { type: "set_param", name: "strength", value: 60, source: "edit" });
    const copy = IdeaTree.replay(structuredClone(t.events));
    expect(copy.head).toBe(t.head);
    const bad = structuredClone(t.events);
    const ev = bad[1];
    if (ev?.body.type === "grow") ev.body.summary = "changed";
    expect(() => IdeaTree.replay(bad)).toThrow(/bad hash/);
  });

  it("keeps questioning bedrock as a proposal until a person accepts it", () => {
    const t = new IdeaTree();
    t.append("person", { type: "goal", text: "g", mode: "standard" });
    const [law] = t.admit("goal", [grown("newton", { role: "bedrock" })]);
    if (!law) throw new Error("not admitted");
    t.append("muse", { type: "grow", under: "goal", nodes: [law], summary: "", usage });
    const under = t.admit("newton", [grown("doubt")]);
    t.append("muse", { type: "grow", under: "newton", nodes: under, summary: "", usage });
    expect(t.status("newton.doubt")).toBe("proposed");
    t.append("person", { type: "reject", node: "newton.doubt" });
    expect(t.nodes.has("newton.doubt")).toBe(false);
  });

  it("accepts repairs only for checks that failed to evaluate", () => {
    const t = planted();
    const skin = t.nodes.get("skin");
    if (!skin?.check || skin.check.kind === "oregonator") throw new Error("missing");
    skin.check.limit = "strenght";
    run(t, "skin");
    expect(t.broken().map((b) => b.id)).toEqual(["skin"]);
    const fixes = t.admitFixes([
      { id: "skin", value: "stress_need", limit: "strength" },
      { id: "cost", value: "1", limit: "2" },
    ]);
    expect(fixes.map((f) => f.node)).toEqual(["skin"]);
    t.append("muse", { type: "repair", fixes, usage });
    run(t, "skin");
    expect(t.status("skin")).toBe("broken");
  });

  it("refuses repairs that change the question", () => {
    const t = planted();
    const skin = t.nodes.get("skin");
    if (!skin?.check || skin.check.kind === "oregonator") throw new Error("missing");
    skin.check.limit = "strenght";
    run(t, "skin");
    const tries = [
      { id: "skin", value: "0", limit: "1" },
      { id: "skin", value: "stress_need", limit: "strength * 10" },
      { id: "skin", value: "strength", limit: "strength" },
    ];
    for (const f of tries) expect(t.admitFixes([f])).toEqual([]);
  });

  it("keeps a check green only while what it rests on is confirmed", () => {
    const t = planted();
    const under = t.admit("cost", [
      grown("child", {
        params: [p("child_need", 1)],
        check: { description: "", value: "child_need", op: "<=", limit: "2", unit: "" },
      }),
    ]);
    t.append("muse", { type: "grow", under: "cost", nodes: under, summary: "", usage });
    const cost = t.nodes.get("cost");
    if (!cost) throw new Error("missing");
    cost.basis = [];
    cost.check = { description: "", value: "1", op: "<=", limit: "2", unit: "" };
    run(t, "cost");
    run(t, "cost.child");
    expect(t.status("cost")).toBe("holds");
    t.append("person", { type: "set_param", name: "child_need", value: 1.5, source: "edit" });
    expect(t.status("cost.child")).toBe("stale");
    expect(t.status("cost")).toBe("unverified");
  });

  it("does not share a name used with another unit", () => {
    const t = planted();
    const under = t.admit("skin", [grown("pa", { params: [p("strength", 12, "assumed", "Pa")] })]);
    expect(under[0]?.params.map((x) => x.name)).toEqual(["strength_pa"]);
    expect(under[0]?.uses).toEqual([]);
  });

  it("rejects a recorded result the engine does not reproduce", () => {
    const t = planted();
    expect(() =>
      t.append("engine", {
        type: "check",
        node: "skin",
        result: { pass: true, value: 55, limit: 12, op: "<=", unit: "MPa", inputs: {} },
      }),
    ).toThrow(/reproduce/);
    expect(t.results.has("skin")).toBe(false);
  });

  it("leaves the tree unchanged when an event fails half way", () => {
    const t = planted();
    const before = t.nodes.size;
    const ok = t.admit("skin", [grown("first")]);
    const bad = {
      ...ok[0],
      id: "skin.second",
      params: [{ ...p("strength", 1), kind: "external" as const }],
    };
    expect(() =>
      t.append("muse", {
        type: "grow",
        under: "skin",
        nodes: [...ok, bad as (typeof ok)[number]],
        summary: "",
        usage,
      }),
    ).toThrow(/already exists/);
    expect(t.nodes.size).toBe(before);
  });
});

describe("round three", () => {
  it("never lets a check that restates its own assumption hold", () => {
    const t = new IdeaTree();
    t.append("person", { type: "goal", text: "A one minute clock", mode: "standard" });
    const nodes = t.admit("goal", [
      grown("minute", {
        params: [
          { ...p("demonstrated_period_s", 60, "assumed", "s"), kind: "external" },
          { ...p("target_period_s", 60, "assumed", "s"), kind: "requirement" },
        ],
        check: {
          kind: "arithmetic",
          description: "",
          value: "demonstrated_period_s",
          op: "<=",
          limit: "target_period_s",
          unit: "s",
        },
      }),
    ]);
    t.append("muse", { type: "grow", under: "goal", nodes, summary: "", usage });
    run(t, "minute");
    expect(t.status("minute")).toBe("argued");
  });

  it("keeps a check conditional when the result it claims is only assumed", () => {
    const make = (origin: string, check: { value: string; observes?: string[] }, name: string) => {
      const t = new IdeaTree();
      t.append("person", { type: "goal", text: "A one minute clock", mode: "standard" });
      const nodes = t.admit("goal", [
        grown("minute", {
          params: [
            { ...p(name, 60, origin, "s"), kind: "external" },
            { ...p("target", 60, "assumed", "s"), kind: "requirement" },
          ],
          check: {
            kind: "arithmetic",
            description: "",
            value: check.value,
            op: "<=",
            limit: "0.1",
            unit: "",
            ...(check.observes ? { observes: check.observes } : {}),
          },
        }),
      ]);
      t.append("muse", { type: "grow", under: "goal", nodes, summary: "", usage });
      run(t, "minute");
      return t.status("minute");
    };
    // Named like an outcome, undeclared: still caught.
    expect(make("assumed", { value: "abs(demonstrated - target) / target" }, "demonstrated")).toBe(
      "argued",
    );
    // Declared by the model under a neutral name.
    expect(
      make(
        "assumed",
        { value: "abs(period_s - target) / target", observes: ["period_s"] },
        "period_s",
      ),
    ).toBe("argued");
    // A measured number with a source is evidence, not an assumption.
    expect(
      make(
        "reference",
        { value: "abs(period_s - target) / target", observes: ["period_s"] },
        "period_s",
      ),
    ).toBe("holds");
  });

  it("refuses a repair that swaps the sides of a comparison", () => {
    const t = new IdeaTree();
    t.append("person", { type: "goal", text: "g", mode: "standard" });
    const nodes = t.admit("goal", [
      grown("beam", {
        params: [p("load", 5), p("strength", 3)],
        check: {
          kind: "arithmetic",
          description: "",
          value: "load",
          op: "<=",
          limit: "strenght",
          unit: "",
        },
      }),
    ]);
    t.append("muse", { type: "grow", under: "goal", nodes, summary: "", usage });
    run(t, "beam");
    expect(t.admitFixes([{ id: "beam", value: "strength", limit: "load" }])).toEqual([]);
    expect(t.admitFixes([{ id: "beam", value: "load * 1", limit: "strength" }])).toEqual([]);
    expect(t.admitFixes([{ id: "beam", value: "load", limit: "strength" }])).toHaveLength(1);
  });

  it("points a node's formula at its own renamed quantity", () => {
    const t = planted();
    const [pa] = t.admit("skin", [
      grown("pa", {
        params: [p("strength", 12, "assumed", "Pa"), p("pa_load", 1, "assumed", "Pa")],
        check: {
          kind: "arithmetic",
          description: "",
          value: "pa_load",
          op: "<=",
          limit: "strength",
          unit: "Pa",
        },
      }),
    ]);
    expect(pa?.check?.kind !== "oregonator" && pa?.check?.limit).toBe("strength_pa");
  });

  it("retries an experiment that failed once its values change", () => {
    const t = new IdeaTree();
    t.append("person", { type: "goal", text: "clock", mode: "standard" });
    const nodes = t.admit("goal", [
      grown("osc", {
        params: [
          { ...p("s", -1, "assumed", ""), kind: "design" },
          { ...p("q", 7.62e-5, "reference", ""), kind: "external" },
          { ...p("eps", 0.0099, "reference", ""), kind: "external" },
          { ...p("eps_prime", 1e-4, "reference", ""), kind: "external" },
        ],
        check: {
          kind: "oregonator",
          question: "oscillates",
          tolerance: 0.05,
          description: "",
          value: "",
          op: "none",
          limit: "",
          unit: "",
        },
      }),
    ]);
    t.append("muse", { type: "grow", under: "goal", nodes, summary: "", usage });
    const spec = t.nodes.get("osc")?.check;
    if (!spec) throw new Error("missing");
    t.append("engine", { type: "check", node: "osc", result: runCheck(spec, t.scope()) });
    t.confirm(seqOf(t, "osc"), runCheck(spec, t.scope()));
    expect(t.status("osc")).toBe("unverified");
    t.append("person", { type: "set_param", name: "s", value: 1, source: "fix" });
    expect(t.status("osc")).toBe("stale");
  });

  it("lets a formula read an experiment's measured period and rest on it", () => {
    const t = new IdeaTree();
    t.append("person", { type: "goal", text: "clock", mode: "standard" });
    const nodes = t.admit("goal", [
      grown("osc", {
        params: [
          { ...p("s", 1, "reference", ""), kind: "design" },
          { ...p("q", 7.62e-5, "reference", ""), kind: "external" },
          { ...p("eps", 0.0099, "reference", ""), kind: "external" },
          { ...p("eps_prime", 1e-4, "reference", ""), kind: "external" },
        ],
        check: {
          kind: "oregonator",
          question: "oscillates",
          tolerance: 0.05,
          description: "",
          value: "",
          op: "none",
          limit: "",
          unit: "",
        },
      }),
      grown("minute", {
        params: [
          { ...p("tau_seconds", 3, "assumed", "s"), kind: "external" },
          { ...p("target_s", 60, "assumed", "s"), kind: "requirement" },
        ],
        check: {
          kind: "arithmetic",
          description: "",
          value: "abs(osc_period_full * tau_seconds - target_s)",
          op: "<=",
          limit: "6",
          unit: "s",
        },
      }),
    ]);
    t.append("muse", { type: "grow", under: "goal", nodes, summary: "", usage });
    expect(t.nodes.get("minute")?.basis).toEqual(["osc"]);
    const spec = t.nodes.get("osc")?.check;
    if (!spec) throw new Error("missing");
    const r = runCheck(spec, t.scope());
    t.append("engine", { type: "check", node: "osc", result: r });
    t.confirm(seqOf(t, "osc"), runCheck(spec, t.scope()));
    expect(t.scope().osc_period_full).toBeGreaterThan(5);
    run(t, "minute");
    const m = t.results.get("minute");
    expect(m && !("error" in m) && m.inputs.osc_period_full).toBeGreaterThan(5);
    // The whole log reopens; what reads the run waits for its confirmation.
    const copy = IdeaTree.replay(structuredClone(t.events));
    expect(copy.status("minute")).toBe("unverified");
    copy.confirm(seqOf(copy, "osc"), runCheck(spec, copy.scope()));
    expect(["holds", "broken", "partial"]).toContain(copy.status("minute"));
  });

  it("keeps the recorded run when a confirmation differs within tolerance, so the log reopens", () => {
    const t = new IdeaTree();
    t.append("person", { type: "goal", text: "clock", mode: "standard" });
    const nodes = t.admit("goal", [
      grown("osc", {
        params: [
          { ...p("s", 1, "reference", ""), kind: "design" },
          { ...p("q", 7.62e-5, "reference", ""), kind: "external" },
          { ...p("eps", 0.0099, "reference", ""), kind: "external" },
          { ...p("eps_prime", 1e-4, "reference", ""), kind: "external" },
        ],
        check: {
          kind: "oregonator",
          question: "oscillates",
          tolerance: 0.05,
          description: "",
          value: "",
          op: "none",
          limit: "",
          unit: "",
        },
      }),
      grown("minute", {
        params: [{ ...p("tau_seconds", 3, "assumed", "s"), kind: "external" }],
        check: {
          kind: "arithmetic",
          description: "",
          value: "osc_period_full * tau_seconds",
          op: "<=",
          limit: "60",
          unit: "s",
        },
      }),
    ]);
    t.append("muse", { type: "grow", under: "goal", nodes, summary: "", usage });
    const spec = t.nodes.get("osc")?.check;
    if (!spec) throw new Error("missing");
    const r = runCheck(spec, t.scope());
    if ("error" in r || !r.sim) throw new Error("no run");
    t.append("engine", { type: "check", node: "osc", result: r });
    const full = r.sim.periods.full ?? NaN;
    const nudged = {
      ...r,
      sim: { ...r.sim, periods: { ...r.sim.periods, full: full * (1 + 1e-5) } },
    };
    t.confirm(seqOf(t, "osc"), nudged);
    expect(t.unconfirmed.has("osc")).toBe(false);
    expect(t.scope().osc_period_full).toBe(full);
    run(t, "minute");
    expect(() => IdeaTree.replay(structuredClone(t.events))).not.toThrow();
  });
});

describe("chemistry experiments", () => {
  const chem = () => {
    const t = new IdeaTree();
    t.append("person", { type: "goal", text: "A chemical clock", mode: "standard" });
    const nodes = t.admit("goal", [
      grown("kinetics", {
        params: [
          { ...p("s", 1, "reference", ""), kind: "design" },
          { ...p("q", 7.62e-5, "reference", ""), kind: "external" },
          { ...p("eps", 0.0099, "reference", ""), kind: "external" },
          { ...p("eps_prime", 1e-4, "reference", ""), kind: "external" },
        ],
        check: {
          kind: "oregonator",
          question: "reduction_keeps_period",
          tolerance: 0.05,
          description: "the two-variable model keeps the period",
          value: "",
          op: "none",
          limit: "",
          unit: "",
        },
      }),
    ]);
    t.append("muse", { type: "grow", under: "goal", nodes, summary: "", usage });
    return t;
  };

  it("runs the Oregonator through the chemistry engine and decides from its protocol", () => {
    const t = chem();
    const spec = t.nodes.get("kinetics")?.check;
    expect(spec?.kind).toBe("oregonator");
    if (!spec) throw new Error("missing");
    const r = runCheck(spec, t.scope());
    if ("error" in r) throw new Error(r.error);
    // At s = 1 the reduction is about 19% off, outside a 5% tolerance.
    expect(r.pass).toBe(false);
    expect(r.value).toBeGreaterThan(0.1);
    expect(r.sim?.periods.full).toBeGreaterThan(r.sim?.periods.reduced ?? Infinity);
  });

  it("counts a recorded experiment only after it reproduces in this browser", () => {
    const t = chem();
    const spec = t.nodes.get("kinetics")?.check;
    if (!spec) throw new Error("missing");
    const r = runCheck(spec, t.scope());
    t.append("engine", { type: "check", node: "kinetics", result: r });
    const copy = IdeaTree.replay(structuredClone(t.events));
    expect(copy.status("kinetics")).toBe("unverified");
    copy.confirm(seqOf(copy, "kinetics"), runCheck(spec, copy.scope()));
    expect(copy.status("kinetics")).toBe("broken");
    const forged = IdeaTree.replay(structuredClone(t.events));
    if ("error" in r) throw new Error(r.error);
    forged.confirm(seqOf(forged, "kinetics"), { ...r, pass: true });
    expect(forged.status("kinetics")).toBe("unverified");
  });
});

describe("predictions and lessons", () => {
  const clock = () => {
    const t = new IdeaTree();
    t.append("person", { type: "goal", text: "A chemical clock", mode: "standard" });
    const nodes = t.admit("goal", [
      grown("kinetics", {
        params: [
          { ...p("s", 1, "reference", ""), kind: "design" },
          { ...p("q", 7.62e-5, "reference", ""), kind: "external" },
          { ...p("eps", 0.0099, "reference", ""), kind: "external" },
          { ...p("eps_prime", 1e-4, "reference", ""), kind: "external" },
        ],
        check: {
          kind: "oregonator",
          question: "reduction_keeps_period",
          tolerance: 0.05,
          description: "",
          value: "",
          op: "none",
          limit: "",
          unit: "",
        },
      }),
    ]);
    t.append("muse", { type: "grow", under: "goal", nodes, summary: "", usage });
    return t;
  };

  const inputs = { s: 1, q: 7.62e-5, eps: 0.0099, eps_prime: 1e-4 };
  const predict = (expect: "holds" | "fails", id = "p1") => ({
    type: "predict" as const,
    id,
    node: "kinetics",
    inputs,
    expect,
    confidence: 0.8,
    reason: "",
    uses: [],
    usage,
  });
  const hypotheses = (extra: { prediction?: string; id?: string } = {}) => ({
    type: "hypotheses" as const,
    id: "h1",
    prediction: "p1",
    candidates: [
      { explanation: "the reduction drifts at low s", scope: "s near 1", expect: "holds" as const },
      { explanation: "the reduction drifts everywhere", scope: "all s", expect: "fails" as const },
    ],
    test: { param: "s", value: 2 },
    open: "the mechanism",
    usage,
    ...extra,
  });
  const runNow = (t: IdeaTree) => {
    const spec = t.nodes.get("kinetics")?.check;
    if (!spec) throw new Error("missing");
    t.append("engine", { type: "check", node: "kinetics", result: runCheck(spec, t.scope()) });
    return spec;
  };

  it("chains prediction, contradicting run, explanations and their test, and invalidates on change", () => {
    const t = clock();
    t.append("muse", predict("holds"));
    const spec = runNow(t);
    // At s = 1 the reduction is about 19% off: the prediction was wrong.
    t.confirm(seqOf(t, "kinetics"), runCheck(spec, t.scope()));
    expect(t.calibration()).toMatchObject({ made: 1, right: 0, surprises: 1 });
    expect(t.calibration().brier).toBeCloseTo(0.64);
    t.append("muse", hypotheses());
    const l = t.lessons[0];
    if (!l) throw new Error("no lesson");
    expect(t.lessonState(l)).toBe("untested");
    const r = runCheck(spec, { ...inputs, s: 2 });
    t.append("engine", { type: "test", hypotheses: "h1", result: r });
    expect(t.lessonState(l)).toBe("unverified");
    t.confirm(l.run ?? -1, runCheck(spec, { ...inputs, s: 2 }));
    expect(t.lessonState(l)).toBe("current");
    const d = t.decided(l);
    if ("error" in r) throw new Error(r.error);
    expect(d?.supported).toBe(r.pass ? 0 : 1);
    // Reopened, nothing counts until the runs reproduce here.
    const copy = IdeaTree.replay(structuredClone(t.events));
    const cl = copy.lessons[0];
    if (!cl) throw new Error("no lesson");
    expect(copy.lessonState(cl)).toBe("unverified");
    expect(copy.calibration()).toMatchObject({ made: 0, pending: 1 });
    for (const run of copy.runsToConfirm()) {
      if (!("error" in run.result)) copy.confirm(run.seq, runCheck(spec, run.result.inputs));
    }
    expect(copy.lessonState(cl)).toBe("current");
    expect(copy.calibration()).toMatchObject({ made: 1, right: 0 });
    t.append("person", { type: "set_param", name: "eps_prime", value: 2e-4, source: "edit" });
    expect(t.lessonState(l)).toBe("invalidated");
  });

  it("refuses a lesson without the history that justifies it", () => {
    const t = clock();
    // No prediction at all.
    expect(() => t.append("muse", hypotheses())).toThrow(/unknown prediction/);
    // A prediction whose run has not happened.
    t.append("muse", predict("holds"));
    expect(() => t.append("muse", hypotheses())).toThrow(/no completed run/);
    // A prediction for values other than the tree's.
    expect(() =>
      t.append("muse", { ...predict("holds", "p2"), inputs: { ...inputs, s: 3 } }),
    ).toThrow(/current values/);
    // A prediction that was right leaves nothing to explain.
    t.append("muse", predict("fails", "p3"));
    const spec = runNow(t);
    expect(() => t.append("muse", hypotheses({ prediction: "p3", id: "h3" }))).toThrow(
      /no surprise/,
    );
    t.append("muse", hypotheses());
    // The test must be the registered one, and only once.
    expect(() =>
      t.append("engine", {
        type: "test",
        hypotheses: "h1",
        result: runCheck(spec, { ...inputs, s: 3 }),
      }),
    ).toThrow(/registered/);
    const r = runCheck(spec, { ...inputs, s: 2 });
    if ("error" in r) throw new Error(r.error);
    // A forged outcome enters the log but never reproduces, so it never counts.
    t.append("engine", { type: "test", hypotheses: "h1", result: { ...r, pass: !r.pass } });
    const l = t.lessons[0];
    if (!l) throw new Error("no lesson");
    t.confirm(l.run ?? -1, runCheck(spec, { ...inputs, s: 2 }));
    expect(t.lessonState(l)).toBe("failed");
    expect(t.decided(l)).toBeUndefined();
  });

  it("keeps each prediction's outcome when the experiment later runs other values", () => {
    const t = clock();
    t.append("muse", predict("holds"));
    const spec = runNow(t);
    t.confirm(seqOf(t, "kinetics"), runCheck(spec, t.scope()));
    t.append("person", { type: "set_param", name: "s", value: 2, source: "edit" });
    runNow(t);
    expect(t.calibration()).toMatchObject({ made: 1, right: 0, surprises: 1 });
  });

  it("refuses explanations that the test cannot tell apart", () => {
    const t = clock();
    t.append("muse", predict("holds"));
    runNow(t);
    const same = hypotheses();
    expect(() =>
      t.append("muse", {
        ...same,
        candidates: same.candidates.map((c) => ({ ...c, expect: "holds" as const })),
      }),
    ).toThrow(/different outcomes/);
  });

  it("keeps a prediction made after a run of its values, but does not score it", () => {
    const t = clock();
    const spec = runNow(t);
    t.confirm(seqOf(t, "kinetics"), runCheck(spec, t.scope()));
    t.append("muse", predict("holds"));
    expect(t.predictions[0]?.blind).toBe(false);
    runNow(t);
    expect(t.calibration()).toMatchObject({ made: 0 });
    // At new values nothing was run yet: the next prediction is foresight.
    t.append("person", { type: "set_param", name: "s", value: 2, source: "edit" });
    t.append("muse", { ...predict("holds", "p2"), inputs: { ...inputs, s: 2 } });
    expect(t.predictions[1]?.blind).toBe(true);
  });

  it("treats a result of the same experiment on another node, or from a test, as seen", () => {
    const t = clock();
    const spec = t.nodes.get("kinetics")?.check;
    if (spec?.kind !== "oregonator") throw new Error("missing");
    const twin = t.admit("goal", [
      grown("kinetics-twin", {
        params: [],
        check: { ...spec, value: "", op: "none", limit: "", unit: "" },
      }),
    ]);
    t.append("muse", { type: "grow", under: "goal", nodes: twin, summary: "", usage });
    const run = runNow(t);
    t.append("muse", { ...predict("holds"), node: "kinetics-twin" });
    expect(t.predictions[0]).toMatchObject({ blind: false, prior: seqOf(t, "kinetics") });
    // The registered test of a lesson also reveals its values.
    t.append("muse", predict("holds", "p2"));
    t.confirm(seqOf(t, "kinetics"), runCheck(run, t.scope()));
    t.append("engine", { type: "check", node: "kinetics", result: runCheck(run, t.scope()) });
    const h = { ...hypotheses(), prediction: "p2" };
    expect(() => t.append("muse", h)).not.toThrow();
    t.append("engine", {
      type: "test",
      hypotheses: "h1",
      result: runCheck(run, { ...inputs, s: 2 }),
    });
    t.append("person", { type: "set_param", name: "s", value: 2, source: "edit" });
    t.append("muse", { ...predict("holds", "p3"), inputs: { ...inputs, s: 2 } });
    expect(t.predictions.find((p) => p.id === "p3")?.blind).toBe(false);
  });

  it("records what a lesson was learned under and stops calling it current when that changes", () => {
    const t = clock();
    t.append("muse", predict("holds"));
    const spec = runNow(t);
    t.confirm(seqOf(t, "kinetics"), runCheck(spec, t.scope()));
    t.append("muse", hypotheses());
    const r = runCheck(spec, { ...inputs, s: 2 });
    t.append("engine", { type: "test", hypotheses: "h1", result: r });
    const l = t.lessons[0];
    if (!l) throw new Error("no lesson");
    t.confirm(l.run ?? -1, r);
    expect(l.identity).toMatchObject({
      question: "reduction_keeps_period",
      tolerance: 0.05,
      engine: 1,
    });
    expect(t.lessonState(l)).toBe("current");
    // The same log under a newer solver: history, not a current finding.
    l.identity.engine = 0;
    expect(t.lessonChanges(l)).toEqual(["solver"]);
    expect(t.lessonState(l)).toBe("invalidated");
    expect(t.lessonsForModel("kinetics")[0]?.applies_here).toMatch(/history/);
  });
});

describe("cost", () => {
  it("prices cached input apart from fresh input", () => {
    expect(cost("muse-spark-1.3", 1e6, 0, 0)).toBeCloseTo(1.25);
    expect(cost("muse-spark-1.3", 1e6, 1e6, 0)).toBeCloseTo(0.15);
    expect(cost("muse-spark-1.3-contributor", 0, 0, 1e6)).toBeCloseTo(0.2);
  });

  it("reserves before sending and refuses beyond the cap", () => {
    const l = new Ledger(0.1);
    const a = l.reserve(0.06);
    expect(() => l.reserve(0.06)).toThrow(BudgetExceeded);
    l.settle(a, { ...usage, cost: 0.01 });
    expect(l.total).toBeCloseTo(0.01);
    const b = l.reserve(0.05);
    // A request that may have been billed keeps its whole reservation.
    l.fail(b);
    expect(l.total).toBeCloseTo(0.06);
    const c = l.reserve(0.01);
    l.cancel(c);
    expect(l.left).toBeCloseTo(0.04);
  });

  it("reserves from the API's own token count and the output ceiling", async () => {
    const seen: string[] = [];
    const fake = (url: string) => {
      seen.push(url);
      if (url.endsWith("/input_tokens")) {
        return Promise.resolve(new Response(JSON.stringify({ input_tokens: 1000 })));
      }
      // The ledger must already hold the ceiling when the request goes out.
      expect(ledger.left).toBeCloseTo(1 - cost("muse-spark-1.3", 1000, 0, 2000));
      return Promise.resolve(new Response(null, { status: 401 }));
    };
    const ledger = new Ledger(1);
    const muse = new Muse({ fetch: fake as typeof fetch }, ledger);
    await expect(
      muse.ask(
        { instructions: "i", input: "x", mode: "standard", effort: "low", maxOutput: 2000 },
        "t",
        {},
      ),
    ).rejects.toThrow();
    expect(seen.map((u) => u.split("/v1")[1])).toEqual(["/responses/input_tokens", "/responses"]);
    // Refused before inference: nothing counts as spent.
    expect(ledger.total).toBe(0);
  });
});

describe("streamed array items", () => {
  it("yields each node as soon as it is complete, whatever the chunking", () => {
    const json = JSON.stringify({
      summary: 'a "b" {c}',
      nodes: [{ key: "x", t: "[}" }, { key: "y" }],
    });
    for (const size of [1, 3, 7, json.length]) {
      const items = new ArrayItems("nodes");
      const out: unknown[] = [];
      for (let i = 0; i < json.length; i += size) out.push(...items.push(json.slice(i, i + size)));
      expect(out).toEqual([{ key: "x", t: "[}" }, { key: "y" }]);
    }
  });
});

describe("recorded sessions", () => {
  const dir = new URL("../../../apps/web/public/examples/", import.meta.url);
  for (const name of ["cardboard-airliner", "chemical-clock", "period-reduction"]) {
    it(`${name} reopens and its experiments reproduce`, async () => {
      const { readFile } = await import("node:fs/promises");
      const data = JSON.parse(await readFile(new URL(`${name}.json`, dir), "utf8")) as {
        events: IdeaEvent[];
      };
      const t = IdeaTree.replay(data.events);
      for (const run of t.runsToConfirm()) {
        const spec = t.nodes.get(run.node)?.check;
        if (!spec) throw new Error(`no check on ${run.node}`);
        t.confirm(run.seq, runCheck(spec, { ...t.scope(), ...(run.result.inputs ?? {}) }));
        expect(run.state).toBe("confirmed");
      }
      for (const l of t.lessons) expect(t.lessonState(l)).toBe("current");
      // Every prediction was made before any run of its values, and nothing
      // in a recording is stale under the current engine.
      for (const p of t.predictions) expect(p.blind).toBe(true);
      for (const n of t.nodes.values()) expect(t.status(n.id)).not.toBe("stale");
    }, 60000);
  }
});

describe("numbers Muse writes", () => {
  it("flags a figure that is not in the data, and accepts honest rounding", () => {
    const data = [11.545, 7.447, 0.55014, 0.05, 2e-4];
    expect(unsupportedNumbers("the gap was 55% against a 5% tolerance", data)).toEqual([]);
    expect(unsupportedNumbers("periods 11.5 and 7.45 at eps_prime 2e-4", data)).toEqual([]);
    expect(unsupportedNumbers("about 35% of the period is lost", data)).toEqual(["35%"]);
    expect(unsupportedNumbers("the error scales like 0.003 per step", data)).toEqual(["0.003"]);
    // Counts and digits inside names are prose, not claims.
    expect(unsupportedNumbers("two explanations, 3 runs, eps_prime2 and s1", data)).toEqual([]);
  });

  it("treats a small number with a unit as a quantity, not a count", () => {
    expect(unsupportedNumbers("it ticks every 5 s at 2 M", [60])).toEqual(["5", "2"]);
    expect(unsupportedNumbers("3 runs and 2 explanations", [60])).toEqual([]);
  });

  it("does not let an earlier answer make its own figure supported", () => {
    const t = new IdeaTree();
    t.append("person", { type: "goal", text: "g", mode: "standard" });
    const nodes = t.admit("goal", [grown("beam", { params: [p("load", 5), p("strength", 3)] })]);
    t.append("muse", { type: "grow", under: "goal", nodes, summary: "", usage });
    const chat = (answer: string) => ({
      type: "chat" as const,
      focus: "beam",
      question: "why?",
      answer,
      cites: ["beam"],
      asked: t.scope(),
      usage,
    });
    t.append("muse", chat("It would need 4.2 MPa."));
    t.append("muse", chat("As I said, 4.2 MPa."));
    expect(t.chat.map((c) => c.unsupported)).toEqual([["4.2"], ["4.2"]]);
  });

  it("derives the flags from the log, so a recorded answer is checked on every replay", () => {
    const t = new IdeaTree();
    t.append("person", { type: "goal", text: "g", mode: "standard" });
    const nodes = t.admit("goal", [grown("beam", { params: [p("load", 5), p("strength", 3)] })]);
    t.append("muse", { type: "grow", under: "goal", nodes, summary: "", usage });
    const chat = (answer: string) => ({
      type: "chat" as const,
      focus: "beam",
      question: "why?",
      answer,
      cites: ["beam"],
      asked: t.scope(),
      usage,
    });
    t.append("muse", chat("The load of 5 MPa exceeds 3 MPa."));
    t.append("muse", chat("It would need 4.2 MPa."));
    const copy = IdeaTree.replay(structuredClone(t.events));
    expect(copy.chat.map((c) => c.unsupported)).toEqual([[], ["4.2"]]);
  });
});

describe("what Muse sees", () => {
  const beam = () => {
    const t = new IdeaTree();
    t.append("person", { type: "goal", text: "g", mode: "standard" });
    const nodes = t.admit("goal", [grown("beam", { params: [p("load", 5), p("strength", 3)] })]);
    t.append("muse", { type: "grow", under: "goal", nodes, summary: "", usage });
    return t;
  };

  it("admits a handwritten formula only in the tree's own names", () => {
    const t = beam();
    const formula = (value: string) => ({
      type: "formula" as const,
      node: "beam",
      reading: "sigma <= f_y",
      check: { value, op: "<=", limit: "strength", unit: "MPa" },
      usage,
    });
    expect(() => t.append("muse", formula("sigma"))).toThrow(/no parameter named sigma/);
    expect(() => t.append("muse", { ...formula("load"), node: "goal" })).toThrow(/unknown root/);
    t.append("muse", formula("load * 1.5"));
    run(t, "beam");
    expect(t.status("beam")).toBe("broken");
    expect(t.nodes.get("beam")?.check?.description).toContain("sigma <= f_y");
  });

  it("keeps what Muse found in its drawing and notes a redraw", () => {
    const t = beam();
    const review = (ok: boolean) => ({
      type: "review" as const,
      node: "beam",
      ok,
      problems: ok ? [] : ["the load arrow points up"],
      usage,
    });
    expect(() => t.append("muse", review(true))).toThrow(/no drawing/);
    const view = { type: "view" as const, node: "beam", title: "v", html: "<p></p>", usage };
    t.append("muse", view);
    t.append("muse", review(false));
    expect(t.reviews.get("beam")).toMatchObject({ ok: false, redrawn: false });
    t.append("muse", view);
    expect(t.reviews.has("beam")).toBe(false);
    t.append("muse", review(true));
    expect(t.reviews.get("beam")).toMatchObject({ ok: true, redrawn: true });
  });
});

const clockWithoutRecipe = () => {
  const t = new IdeaTree();
  t.append("person", { type: "goal", text: "clock", mode: "standard" });
  const nodes = t.admit("goal", [
    grown("clock", {
      params: [
        { ...p("s", 1, "reference", ""), kind: "design" },
        { ...p("q", 7.62e-5, "reference", ""), kind: "external" },
        { ...p("eps", 0.0099, "reference", ""), kind: "external" },
        { ...p("eps_prime", 2e-4, "reference", ""), kind: "external" },
      ],
      check: {
        kind: "oregonator",
        question: "reduction_keeps_period",
        tolerance: 0.05,
        description: "",
        value: "",
        op: "none",
        limit: "",
        unit: "",
      },
    }),
  ]);
  t.append("muse", { type: "grow", under: "goal", nodes, summary: "", usage });
  const spec = t.nodes.get("clock")?.check;
  if (!spec) throw new Error("missing");
  t.append("muse", {
    type: "predict",
    id: "p1",
    node: "clock",
    inputs: { s: 1, q: 7.62e-5, eps: 0.0099, eps_prime: 2e-4 },
    expect: "holds",
    confidence: 0.8,
    reason: "",
    uses: [],
    usage,
  });
  t.append("engine", { type: "check", node: "clock", result: runCheck(spec, t.scope()) });
  return t;
};

describe("a real recipe in the tree", () => {
  const recipeTree = () => {
    const t = new IdeaTree();
    t.append("person", { type: "goal", text: "A BZ clock", mode: "standard" });
    const nodes = t.admit("goal", [
      grown("clock", {
        params: [
          { ...p("bromate", 0.06, "reference", "M"), kind: "design" },
          { ...p("malonic_acid", 0.2, "reference", "M"), kind: "design" },
          { ...p("acid", 0.8, "reference", "M"), kind: "design" },
          { ...p("s", 1, "assumed", ""), kind: "external" },
        ],
        check: {
          kind: "oregonator",
          question: "reduction_keeps_period",
          tolerance: 0.15,
          description: "",
          value: "",
          op: "none",
          limit: "",
          unit: "",
        },
      }),
    ]);
    t.append("muse", { type: "grow", under: "goal", nodes, summary: "", usage });
    return t;
  };

  it("tests a recipe change by re-deriving the whole model, and labels a model change", () => {
    const t = recipeTree();
    const spec = t.nodes.get("clock")?.check;
    if (!spec) throw new Error("missing");
    const inputs = Object.fromEntries(SIM_PARAMS.map((k) => [k, t.scope()[k] ?? NaN]));
    t.append("muse", {
      type: "predict",
      id: "p1",
      node: "clock",
      inputs,
      expect: "holds",
      confidence: 0.8,
      reason: "",
      uses: [],
      usage,
    });
    t.append("engine", { type: "check", node: "clock", result: runCheck(spec, t.scope()) });
    const hyp = (param: string, value: number, id: string) => ({
      type: "hypotheses" as const,
      id,
      prediction: "p1",
      candidates: [
        { explanation: "a", scope: "", expect: "holds" as const },
        { explanation: "b", scope: "", expect: "fails" as const },
      ],
      test: { param, value },
      open: "",
      usage,
    });
    t.append("muse", hyp("malonic_acid", 0.02, "h1"));
    const l = t.lessons[0];
    if (!l) throw new Error("no lesson");
    expect(l.intervention).toBe("recipe");
    const want = t.testScope(l);
    // Less malonic acid moves eps, eps_prime and the time scale together.
    expect(want.eps_prime).toBeCloseTo(1.98e-5, 7);
    expect(want.eps).toBeCloseTo(9.92e-3, 5);
    expect(want.time_scale_s).toBeCloseTo(50);
    // Changing only eps_prime is not that recipe change.
    expect(() =>
      t.append("engine", {
        type: "test",
        hypotheses: "h1",
        result: runCheck(spec, { ...l.basis, eps_prime: want.eps_prime ?? NaN }),
      }),
    ).toThrow(/registered/);
    t.append("engine", { type: "test", hypotheses: "h1", result: runCheck(spec, want) });
    // A value Muse gives for something the recipe sets is set aside, not used.
    const more = t.admit("goal", [
      grown("tuning", { params: [{ ...p("eps", 0.5, "assumed", ""), kind: "external" }] }),
    ]);
    expect(more[0]?.overridden).toEqual(["eps"]);
    expect(more[0]?.params).toEqual([]);
    expect(more[0]?.suggestions).toEqual([]);
    // Without a recipe, a recipe change is refused; with one, a model change is labelled.
    const plain = clockWithoutRecipe();
    expect(() => plain.append("muse", hyp("malonic_acid", 0.1, "h2"))).toThrow(/no recipe/);
  }, 60000);

  it("derives the model from the recipe and gives the period in seconds", () => {
    const t = new IdeaTree();
    t.append("person", { type: "goal", text: "A BZ clock from a recipe", mode: "standard" });
    const nodes = t.admit("goal", [
      grown("clock", {
        params: [
          { ...p("bromate", 0.06, "reference", "M"), kind: "design" },
          { ...p("malonic_acid", 0.02, "reference", "M"), kind: "design" },
          { ...p("acid", 0.8, "reference", "M"), kind: "design" },
          { ...p("s", 1, "assumed", ""), kind: "external" },
        ],
        check: {
          kind: "oregonator",
          question: "oscillates",
          tolerance: 0.05,
          description: "",
          value: "",
          op: "none",
          limit: "",
          unit: "",
        },
      }),
      grown("minute", {
        params: [{ ...p("target_period_s", 60, "assumed", "s"), kind: "requirement" }],
        check: {
          kind: "arithmetic",
          description: "",
          value: "abs(clock_period_full_s - target_period_s)",
          op: "<=",
          limit: "10",
          unit: "s",
        },
      }),
    ]);
    t.append("muse", { type: "grow", under: "goal", nodes, summary: "", usage });
    expect(t.nodes.get("minute")?.basis).toEqual(["clock"]);
    expect(t.derived().time_scale_s).toBeCloseTo(50);
    expect(t.scope().eps_prime).toBeCloseTo(1.98e-5, 7);
    const spec = t.nodes.get("clock")?.check;
    if (!spec) throw new Error("missing");
    const r = runCheck(spec, t.scope());
    t.append("engine", { type: "check", node: "clock", result: r });
    t.confirm(seqOf(t, "clock"), runCheck(spec, t.scope()));
    if ("error" in r) throw new Error(r.error);
    const seconds = t.scope().clock_period_full_s ?? NaN;
    expect(seconds).toBeCloseTo((r.sim?.periods.full ?? NaN) * 50, 6);
    run(t, "minute");
    expect(t.status("minute")).not.toBe("unverified");
    // Changing the recipe changes the model it implies: the run is stale.
    t.append("person", { type: "set_param", name: "malonic_acid", value: 0.04, source: "edit" });
    expect(t.scope().time_scale_s).toBeCloseTo(25);
    expect(t.status("clock")).toBe("stale");
    // Evidence computed under another version of the conversion is stale.
    const fresh = runCheck(spec, t.scope());
    if ("error" in fresh) throw new Error(fresh.error);
    expect(fresh.inputs.recipe_version).toBe(t.scope().recipe_version);
    t.append("engine", { type: "check", node: "clock", result: fresh });
    t.confirm(seqOf(t, "clock"), fresh);
    expect(t.status("clock")).toBe("holds");
    const older = IdeaTree.replay(structuredClone(t.events));
    const last = older.latestRun("clock");
    if (!last || "error" in last.result) throw new Error("no run");
    older.results.set("clock", {
      ...last.result,
      inputs: { ...last.result.inputs, recipe_version: 1 },
    });
    expect(older.status("clock")).toBe("stale");
    // A derived value is not anyone's to set by hand.
    expect(() =>
      t.append("person", { type: "set_param", name: "eps", value: 0.01, source: "edit" }),
    ).toThrow(/no parameter/);
  }, 60000);
});

describe("the audit of refusals", () => {
  it("keeps what the engine refused beside the log, without changing its state", () => {
    const t = new IdeaTree();
    t.append("person", { type: "goal", text: "g", mode: "standard" });
    const before = t.events.length;
    expect(() =>
      t.append("muse", {
        type: "hypotheses",
        id: "h1",
        prediction: "nope",
        candidates: [],
        test: { param: "s", value: 2 },
        open: "",
        usage,
      }),
    ).toThrow(/unknown prediction/);
    expect(t.events.length).toBe(before);
    expect(t.refused).toEqual([
      { at: before, actor: "muse", what: "hypotheses", reason: "unknown prediction nope" },
    ]);
    // A root off the protocol is dropped and said so.
    t.admit("goal", [{ ...grown("bad"), axis: "nowhere" }]);
    expect(t.refused.at(-1)?.reason).toMatch(/did not follow the protocol: bad/);
  });
});
