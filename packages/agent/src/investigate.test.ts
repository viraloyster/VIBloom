import type { Contract, ResultRecord } from "@vibloom/contracts";
import { basisFor, Project, type Op } from "@vibloom/engine";
import { describe, expect, it } from "vitest";
import { BUDGET, investigate, type Workspace } from "./investigate";
import { ScriptedProvider } from "./scripted";

const contract: Contract = {
  version: "test",
  models: { full: { params: ["s", "eps_prime"] }, reduced: { params: ["s"] } },
  domain: {
    s: { min: 0.4, max: 2.8, scale: "linear" },
    eps_prime: { min: 1e-6, max: 1e-2, scale: "log" },
  },
  initialConditions: ["far", "near"],
};

// A deterministic stand-in for the solver: the reduction holds below s = 1.5.
function workspace(): Workspace & { project: Project } {
  const project = new Project(contract);
  let n = 0;
  const submit = (actor: string, ops: Op[], approved = false) =>
    project.submit(
      { commandId: `c${String(++n)}`, actor, baseHead: project.head, ops, approved },
      `t${String(n)}`,
    );
  submit(
    "human",
    [
      {
        op: "add_node",
        node: {
          kind: "model",
          id: "oregonator",
          title: "Oregonator",
          name: "oregonator",
          version: "1",
          equations: "see docs/science.md",
          params: { q: 7.62e-5, eps: 9.9e-3 },
          scaling: "tau = d t",
        },
      },
    ],
    true,
  );
  return {
    project,
    state: () => project.state,
    submitAsAgent: (ops) => submit("agent", ops),
    runPoint: ({ experiment, point }) => {
      const s = project.state;
      const exp = s.nodes.get(experiment);
      if (exp?.kind !== "experiment") return { ok: false, code: "not_found", detail: experiment };
      const claim = s.nodes.get(exp.spec.claim.id);
      if (claim?.kind !== "claim" || claim.predicate.kind !== "FOR_ALL") {
        return { ok: false, code: "invalid_input", detail: "region claims only" };
      }
      const range = claim.predicate.region.s;
      const sv = point.s ?? NaN;
      if (!range || sv < range.min || sv > range.max) {
        return { ok: false, code: "invalid_input", detail: "s must lie in the claim region" };
      }
      const holds = sv < 1.5;
      const result: ResultRecord = {
        id: `r${String(s.results.size + 1)}`,
        experiment: { id: exp.id, revision: exp.revision },
        claim: { id: claim.id, revision: claim.revision },
        assumptions: [],
        basis: basisFor(s, exp.id, []),
        execution: { status: "completed" },
        // Stored as the server does: with the claim's fixed values filled in.
        point: { eps_prime: claim.predicate.fixed.eps_prime ?? NaN, ...point },
        outcome: holds ? "holds" : "fails",
        region: holds
          ? { status: "no_counterexample", evaluated: 1, inconclusive: 0 }
          : { status: "counterexample_found", counterexamples: 1, evaluated: 1, inconclusive: 0 },
      };
      const r = submit("engine", [{ op: "record_result", result }]);
      return r.ok ? { ok: true, result } : r;
    },
  };
}

const predicate = (max: number) => ({
  kind: "FOR_ALL",
  region: { s: { min: 0.6, max } },
  fixed: { eps_prime: 1e-4 },
  ic: "far",
  body: { kind: "AGREE_AND_PERIOD_WITHIN", reference: "full", reduced: "reduced", tolerance: 0.05 },
});

const formulate = {
  action: "formulate",
  question: "Does removing the bromide variable keep the oscillations?",
  ambiguities: ["'keep' could mean existence or period; both are tested"],
  claims: [
    {
      id: "keeps-period",
      title: "The reduction keeps the period",
      text: "Within 5% for s in [0.6, 2.3]",
      predicate: predicate(2.3),
    },
  ],
  assumptions: [
    {
      id: "fast-bromide",
      title: "Bromide is fast",
      statement: "eps_prime << eps",
      scope: "reduction",
    },
  ],
  dependencies: [{ from: "keeps-period", to: "fast-bromide", reason: "the reduction needs it" }],
  rationale: "turn the question into a testable region claim",
  cites: ["oregonator"],
};

const run = (experiment: string, s: number, outcome: "holds" | "fails", extra = {}) => ({
  action: "run_point",
  experiment,
  point: { s },
  distinguishes: ["fails only near onset", "fails everywhere"],
  prediction: { outcome, because: "reasoned from the timescales" },
  rationale: "probe the region",
  cites: [experiment],
  ...extra,
});

describe("investigate", () => {
  it("formulates, predicts, is surprised, revises and concludes", async () => {
    const ws = workspace();
    const provider = new ScriptedProvider([
      formulate,
      run("keeps-period-runs", 1.0, "holds"),
      run("keeps-period-runs", 2.0, "holds"),
      // Moving on without explaining the surprise is refused.
      run("keeps-period-runs", 0.8, "holds"),
      {
        action: "revise",
        previous: { id: "keeps-period", revision: 1 },
        claim: {
          id: "keeps-period-low-s",
          title: "The reduction keeps the period at low s",
          text: "Within 5% for s in [0.6, 1.5]",
          predicate: predicate(1.5),
        },
        changes: "region narrowed from [0.6, 2.3] to [0.6, 1.5]",
        surprise: "the drift grows with s; the slow bromide matters at high s",
        rationale: "separate the regime where the reduction works",
        cites: ["r2"],
      },
      // The point that shaped the revision cannot test it.
      run("keeps-period-low-s-runs", 1.0, "holds"),
      run("keeps-period-low-s-runs", 1.2, "holds"),
      {
        action: "conclude",
        claim: "keeps-period-low-s",
        verdict: "no_counterexample",
        results: ["r3"],
        limits: "one point, s = 1.2, far initial condition",
        interpretation: "Version 1 failed at s = 2.0; the narrowed claim held at a fresh point.",
        rationale: "enough to report",
        cites: ["r2", "r3"],
      },
    ]);

    const inv = await investigate("Does the reduction keep the oscillations?", provider, ws);
    expect(inv.stop).toBe("concluded");
    expect(inv.trace.map((t) => t.accepted)).toEqual([
      true,
      true,
      true,
      false,
      true,
      false,
      true,
      true,
    ]);
    expect(inv.trace.map((t) => t.prediction?.verdict ?? null)).toEqual([
      null,
      "as_predicted",
      "surprise",
      null,
      null,
      null,
      "as_predicted",
      null,
    ]);
    expect(inv.trace[3]?.rejection).toMatch(/explain the surprise/);
    expect(inv.trace[5]?.rejection).toMatch(/fresh points/);
    // The model saw why it was refused.
    expect(provider.requests[4]?.feedback).toMatch(/explain the surprise/);

    const s = ws.project.state;
    expect(s.nodes.get("fast-bromide")).toMatchObject({ state: "hypothetical" });
    expect(s.edges).toContainEqual(
      expect.objectContaining({
        from: "keeps-period",
        to: "fast-bromide",
        origin: "model",
        state: "hypothetical",
      }),
    );
    expect(s.nodes.get("keeps-period-low-s")).toMatchObject({
      version: 2,
      supersedes: { id: "keeps-period", revision: 1 },
    });
    // The refutation of version 1 is still on record.
    expect(s.results.get("r2")).toMatchObject({ outcome: "fails" });
  });

  it("refuses citations to things that do not exist", async () => {
    const ws = workspace();
    const inv = await investigate(
      "q",
      new ScriptedProvider([
        { ...formulate, cites: ["made-up-paper"] },
        {
          action: "ask_researcher",
          question: "Which tolerance?",
          rationale: "ambiguous",
          cites: [],
        },
      ]),
      ws,
    );
    expect(inv.trace[0]?.rejection).toMatch(/made-up-paper/);
    expect(inv.stop).toBe("asked_researcher");
  });

  it("allows a single escalation of reasoning effort", async () => {
    const ws = workspace();
    const provider = new ScriptedProvider([
      { ...formulate, escalate: "two incompatible readings of the question" },
      {
        action: "ask_researcher",
        question: "Which one?",
        rationale: "r",
        cites: [],
        escalate: "again",
      },
      { action: "ask_researcher", question: "Which one?", rationale: "r", cites: [] },
    ]);
    const inv = await investigate("q", provider, ws);
    expect(provider.requests.map((r) => r.effort)).toEqual(["low", "medium", "medium"]);
    expect(inv.trace[1]?.rejection).toMatch(/only once/);
    expect(inv.stop).toBe("asked_researcher");
  });

  it("does not accept a conclusion without results", async () => {
    const ws = workspace();
    const inv = await investigate(
      "q",
      new ScriptedProvider([
        {
          action: "conclude",
          claim: "oregonator",
          verdict: "holds",
          results: [],
          limits: "none",
          interpretation: "It works.",
          rationale: "trust me",
          cites: ["oregonator"],
        },
        { action: "ask_researcher", question: "q", rationale: "r", cites: [] },
      ]),
      ws,
    );
    expect(inv.trace[0]?.rejection).toMatch(/not a claim/);
  });

  it("stops at the call budget when the model keeps failing", async () => {
    const ws = workspace();
    const inv = await investigate(
      "q",
      new ScriptedProvider(Array.from({ length: 20 }, () => ({ action: "guess" }))),
      ws,
    );
    expect(inv.stop).toBe("budget_exhausted");
    expect(inv.trace).toHaveLength(BUDGET.calls);
    expect(ws.project.head).toBe(1);
  });

  it("checks a conclusion against the derived verdict and current results", async () => {
    const ws = workspace();
    const conclude = (verdict: string, results: string[]) => ({
      action: "conclude",
      claim: "keeps-period",
      verdict,
      results,
      limits: "one point",
      interpretation: "x",
      rationale: "r",
      cites: [],
    });
    const inv = await investigate(
      "q",
      new ScriptedProvider([
        formulate,
        run("keeps-period-runs", 2.0, "fails"),
        conclude("holds", ["r1"]),
        conclude("refuted", []),
        conclude("refuted", ["r1"]),
      ]),
      ws,
    );
    expect(inv.trace[2]?.rejection).toMatch(/derives refuted/);
    expect(inv.trace[3]?.rejection).toMatch(/at least one result/);
    expect(inv.stop).toBe("concluded");
  });
});
