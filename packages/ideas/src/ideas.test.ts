import { describe, expect, it } from "vitest";
import { runCheck, thresholds } from "./check";
import { BudgetExceeded, cost, Ledger } from "./cost";
import { evaluate } from "./expr";
import { Muse } from "./muse";
import type { GrownNode } from "./protocol";
import { ArrayItems } from "./stream";
import { IdeaTree } from "./tree";
import type { Usage } from "./types";

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
    t.confirm("osc", runCheck(spec, t.scope()));
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
    t.confirm("osc", runCheck(spec, t.scope()));
    expect(t.scope().osc_period_full).toBeGreaterThan(5);
    run(t, "minute");
    const m = t.results.get("minute");
    expect(m && !("error" in m) && m.inputs.osc_period_full).toBeGreaterThan(5);
    // The whole log reopens; what reads the run waits for its confirmation.
    const copy = IdeaTree.replay(structuredClone(t.events));
    expect(copy.status("minute")).toBe("unverified");
    copy.confirm("osc", runCheck(spec, copy.scope()));
    expect(["holds", "broken", "partial"]).toContain(copy.status("minute"));
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
    copy.confirm("kinetics", runCheck(spec, copy.scope()));
    expect(copy.status("kinetics")).toBe("broken");
    const forged = IdeaTree.replay(structuredClone(t.events));
    if ("error" in r) throw new Error(r.error);
    forged.confirm("kinetics", { ...r, pass: true });
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

  it("records a surprise, settles explanations by a run, and invalidates the lesson when a premise changes", () => {
    const t = clock();
    const spec = t.nodes.get("kinetics")?.check;
    if (!spec) throw new Error("missing");
    const inputs = { s: 1, q: 7.62e-5, eps: 0.0099, eps_prime: 1e-4 };
    t.append("muse", {
      type: "predict",
      node: "kinetics",
      inputs,
      expect: "holds",
      confidence: 0.8,
      reason: "",
      uses: [],
      usage,
    });
    t.append("engine", { type: "check", node: "kinetics", result: runCheck(spec, t.scope()) });
    expect(t.calibration()).toEqual({ made: 1, right: 0, surprises: 1 });
    const test = { param: "s", value: 2 };
    const r = runCheck(spec, { ...inputs, s: 2 });
    if ("error" in r) throw new Error(r.error);
    const outcome: "holds" | "fails" = r.pass ? "holds" : "fails";
    const lesson = {
      type: "lesson" as const,
      id: "l1",
      node: "kinetics",
      basis: inputs,
      observed: "fails" as const,
      candidates: [
        {
          explanation: "the reduction drifts at low s",
          scope: "s near 1",
          expect: "holds" as const,
        },
        {
          explanation: "the reduction drifts everywhere",
          scope: "all s",
          expect: "fails" as const,
        },
      ],
      test,
      outcome,
      usage,
    };
    t.append("muse", lesson);
    const l = t.lessons[0];
    expect(l?.supported).toBe(outcome === "holds" ? 0 : 1);
    expect(t.lessonState(l ?? (undefined as never))).toBe("current");
    t.append("person", { type: "set_param", name: "eps_prime", value: 2e-4, source: "edit" });
    expect(t.lessonState(l ?? (undefined as never))).toBe("invalidated");
    // A recorded outcome the engine does not reach is refused.
    const forged = clock();
    expect(() =>
      forged.append("muse", { ...lesson, outcome: outcome === "holds" ? "fails" : "holds" }),
    ).toThrow(/reproduce/);
    expect(forged.lessons).toHaveLength(0);
  });

  it("refuses explanations that the test cannot tell apart", () => {
    const t = clock();
    expect(() =>
      t.append("muse", {
        type: "lesson",
        id: "l2",
        node: "kinetics",
        basis: { s: 1, q: 7.62e-5, eps: 0.0099, eps_prime: 1e-4 },
        observed: "fails",
        candidates: [
          { explanation: "a", scope: "", expect: "holds" },
          { explanation: "b", scope: "", expect: "holds" },
        ],
        test: { param: "s", value: 2 },
        outcome: "holds",
        usage,
      }),
    ).toThrow(/different outcomes/);
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
