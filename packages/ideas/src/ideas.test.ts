import { describe, expect, it } from "vitest";
import { evaluate, lockdown, toResult } from "./check";
import { BudgetExceeded, cost, Ledger } from "./cost";
import type { GrownNode } from "./protocol";
import { ArrayItems } from "./stream";
import { IdeaTree } from "./tree";
import type { Usage } from "./types";

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
  check: { description: "", code: "" },
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

function planted() {
  const t = new IdeaTree();
  t.append("person", { type: "goal", text: "Cardboard airliner", mode: "standard" });
  const nodes = t.admit("goal", [
    grown("skin", {
      params: [
        {
          name: "stress need",
          value: 55,
          unit: "MPa",
          origin: "reference",
          source: "Laplace pR/t",
        },
        { name: "strength", value: 12, unit: "MPa", origin: "assumed", source: "ignored" },
      ],
      check: {
        description: "",
        code: "return { value: p.strength, limit: p.stress_need, unit: 'MPa', pass: p.strength >= p.stress_need, detail: '' };",
      },
    }),
    grown("cost", { risk: "low", basis: ["skin", "nowhere"] }),
  ]);
  t.append("muse", { type: "grow", under: "goal", nodes, summary: "", usage });
  return t;
}

const run = (t: IdeaTree, id: string) => {
  const code = t.nodes.get(id)?.check?.code ?? "";
  const { raw, read } = evaluate(code, t.scope(id));
  t.append("engine", { type: "check", node: id, result: toResult(raw, read) });
};

describe("idea tree", () => {
  it("admits model output only on protocol, with clean names and resolved basis", () => {
    const t = planted();
    const skin = t.nodes.get("skin");
    expect(skin?.params.map((p) => p.name)).toEqual(["stress_need", "strength"]);
    // An assumed value never keeps a source.
    expect(skin?.params[1]?.source).toBe("");
    expect(t.nodes.get("cost")?.basis).toEqual(["skin"]);
    expect(t.admit("goal", [{ ...grown("bad"), axis: "astrology" }])).toEqual([]);
  });

  it("derives red from a computation, and marks what rests on it", () => {
    const t = planted();
    run(t, "skin");
    expect(t.status("skin")).toBe("broken");
    expect(t.status("cost")).toBe("affected");
    expect(t.status("goal")).toBe("affected");
    expect(t.assumedInputs("skin").map((p) => p.name)).toEqual(["strength"]);
  });

  it("marks a result stale when a value it read changes, and recomputes", () => {
    const t = planted();
    run(t, "skin");
    t.append("person", { type: "set_param", node: "skin", name: "strength", value: 60 });
    expect(t.status("skin")).toBe("stale");
    run(t, "skin");
    expect(t.status("skin")).toBe("holds");
    expect(t.status("goal")).toBe("goal");
  });

  it("replays its own log and refuses a tampered one", () => {
    const t = planted();
    run(t, "skin");
    t.append("person", { type: "set_param", node: "skin", name: "strength", value: 60 });
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

  it("accepts repairs only for checks that failed to run", () => {
    const t = planted();
    t.append("engine", { type: "check", node: "skin", result: { error: "boom" } });
    expect(t.broken().map((b) => b.id)).toEqual(["skin"]);
    const fixes = t.admitFixes([
      { id: "skin", code: "return { value: 1, limit: 2, unit: '', pass: true, detail: '' };" },
      { id: "cost", code: "return 1;" },
    ]);
    expect(fixes.map((f) => f.node)).toEqual(["skin"]);
    t.append("muse", { type: "repair", fixes, usage });
    run(t, "skin");
    expect(t.status("skin")).toBe("holds");
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

describe("checks", () => {
  it("records which parameters a check read and validates its result", () => {
    const { raw, read } = evaluate(
      "return { value: p.a * 2, limit: 3, unit: 'm', pass: true, detail: '' };",
      { a: 1, b: 2 },
    );
    expect(read).toEqual({ a: 1 });
    expect(toResult(raw, read)).toMatchObject({ value: 2, pass: true });
    expect(toResult({ value: NaN, limit: 1, pass: true }, {})).toHaveProperty("error");
  });

  it("cannot write to the parameters", () => {
    expect(() => evaluate("p.a = 5; return null;", { a: 1 })).toThrow();
  });

  it("removes network and storage from the global scope", () => {
    const scope = { fetch: () => 1, WebSocket: 1, keep: 2 };
    lockdown(scope);
    expect(scope.fetch).toBeUndefined();
    expect(scope.WebSocket).toBeUndefined();
    expect(scope.keep).toBe(2);
  });
});
