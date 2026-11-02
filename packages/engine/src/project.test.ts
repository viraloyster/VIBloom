import type { Contract, ResultRecord } from "@vibloom/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor, Command, NewNode, Op } from "./commands";
import { claimView, resultView } from "./derive";
import { canonical } from "./hash";
import { Project } from "./project";

const contract: Contract = {
  version: "test",
  models: { full: { params: ["s", "eps_prime"] }, reduced: { params: ["s"] } },
  domain: {
    s: { min: 0.4, max: 2.8, scale: "linear" },
    eps_prime: { min: 1e-6, max: 1e-2, scale: "log" },
  },
  initialConditions: ["far", "near"],
};

const region = {
  kind: "FOR_ALL" as const,
  region: { s: { min: 0.6, max: 2.3 } },
  fixed: { eps_prime: 1.98e-5 },
  ic: "far",
  body: {
    kind: "AGREE_AND_PERIOD_WITHIN" as const,
    reference: "full",
    reduced: "reduced",
    tolerance: 0.05,
  },
};

const nodes: Record<string, NewNode> = {
  qssa: {
    kind: "assumption",
    id: "qssa",
    title: "Quasi-steady bromide",
    statement: "eps_prime y' = 0",
    scope: "reduced model",
    state: "adopted",
    protected: false,
  },
  q: {
    kind: "assumption",
    id: "q",
    title: "q = 7.62e-5",
    statement: "q = 7.62e-5",
    scope: "all",
    state: "adopted",
    protected: true,
  },
  model: {
    kind: "model",
    id: "model",
    title: "Oregonator",
    name: "oregonator",
    version: "1",
    equations: "see docs/science.md",
    params: { q: 7.62e-5, eps: 9.9e-3 },
    scaling: "tau = d t",
  },
  claim: {
    kind: "claim",
    id: "claim",
    title: "Reduction keeps the period",
    version: 1,
    text: "Within 5% for s in [0.6, 2.3]",
    predicate: region,
    protocol: "robust-v1",
  },
  exp: {
    kind: "experiment",
    id: "exp",
    title: "Sweep s",
    spec: {
      model: { id: "model", revision: 1 },
      claim: { id: "claim", revision: 1 },
      solver: "seulex-v1",
      detector: "peaks-v1",
      protocol: "robust-v1",
      seed: 7,
    },
    results: [],
  },
  positivity: {
    kind: "invariant",
    id: "positivity",
    title: "Concentrations are non-negative",
    check: "non_negative_state",
    version: "1",
    scope: "all runs",
  },
};

let p: Project;
let n = 0;
const send = (actor: Actor, ops: Op[], extra: Partial<Command> = {}) =>
  p.submit(
    { commandId: `c${String(++n)}`, actor, baseHead: p.state.head, ops, ...extra },
    `2026-11-02T00:00:${String(n).padStart(2, "0")}Z`,
  );

const result = (id: string, over: Partial<ResultRecord> = {}): ResultRecord => ({
  id,
  experiment: { id: "exp", revision: 1 },
  claim: { id: "claim", revision: 1 },
  assumptions: [
    { id: "qssa", revision: 1 },
    { id: "q", revision: 1 },
  ],
  execution: { status: "completed" },
  region: { status: "no_counterexample", evaluated: 64, inconclusive: 2 },
  ...over,
});

const snapshot = (q: Project) =>
  canonical({
    head: q.state.head,
    nodes: [...q.state.nodes],
    edges: q.state.edges,
    results: [...q.state.results],
  });

beforeEach(() => {
  p = new Project(contract);
  n = 0;
  const setup = send(
    "human",
    Object.values(nodes).map((node) => ({ op: "add_node", node })),
    { approved: true },
  );
  expect(setup.ok).toBe(true);
  expect(
    send("human", [
      { op: "add_edge", edge: { from: "claim", to: "qssa", origin: "human", state: "confirmed" } },
    ]).ok,
  ).toBe(true);
});

describe("evidence and derived verdicts", () => {
  it("reports a region as having no counterexample, never as holding", () => {
    expect(send("engine", [{ op: "record_result", result: result("r1") }]).ok).toBe(true);
    expect(claimView(p.state, "claim")?.verdict).toEqual({
      verdict: "no_counterexample",
      by: ["r1"],
      evaluated: 64,
    });
  });

  it("lets current contrary evidence win and keeps it", () => {
    send("engine", [{ op: "record_result", result: result("r1") }]);
    const refuting = result("r2", {
      region: { status: "counterexample_found", counterexamples: 1, evaluated: 9, inconclusive: 0 },
    });
    expect(send("engine", [{ op: "record_result", result: refuting }]).ok).toBe(true);
    expect(claimView(p.state, "claim")?.verdict).toEqual({ verdict: "refuted", by: ["r2"] });
  });

  it("keeps failed runs as records that neither support nor refute", () => {
    const failed = result("r1", {
      execution: { status: "failed", reason: "domain_exit" },
      violated: { invariant: { id: "positivity", revision: 1 }, detail: "y < 0 at tau 3.2" },
    });
    expect(send("engine", [{ op: "record_result", result: failed }]).ok).toBe(true);
    const view = claimView(p.state, "claim");
    expect(view?.verdict).toEqual({ verdict: "unexplored" });
    expect(view?.failedRuns).toEqual(["r1"]);
  });
});

describe("propagation", () => {
  it("makes results unsupported when an assumption they need is switched off", () => {
    send("engine", [{ op: "record_result", result: result("r1") }]);
    expect(
      send("human", [
        { op: "set_assumption", id: "qssa", expectedRevision: 1, change: { state: "off" } },
      ]).ok,
    ).toBe(true);
    const view = claimView(p.state, "claim");
    expect(view?.verdict).toEqual({ verdict: "unexplored" });
    expect(view?.notCurrent[0]).toMatchObject({ id: "r1", currency: "unsupported" });
  });

  it("marks results pending review when an assumption they pinned changes", () => {
    send("engine", [{ op: "record_result", result: result("r1") }]);
    send("human", [
      { op: "set_assumption", id: "qssa", expectedRevision: 1, change: { scope: "s < 2" } },
    ]);
    expect(resultView(p.state, p.state.results.get("r1")!).currency).toBe("pending_review");
  });

  it("invalidates justifications, not conclusions", () => {
    send("human", [
      { op: "add_node", node: { ...nodes.qssa, id: "alt", title: "Other route" } as NewNode },
    ]);
    send("engine", [
      { op: "record_result", result: result("r1") },
      { op: "record_result", result: result("r2", { assumptions: [{ id: "alt", revision: 1 }] }) },
    ]);
    // r1 needs qssa directly; r2 needs it only through the claim's confirmed edge.
    send("human", [
      { op: "set_assumption", id: "alt", expectedRevision: 1, change: { state: "off" } },
    ]);
    expect(claimView(p.state, "claim")?.verdict).toMatchObject({
      verdict: "no_counterexample",
      by: ["r1"],
    });
  });

  it("does not let a late result computed on an old revision count", () => {
    send("human", [
      { op: "set_assumption", id: "qssa", expectedRevision: 1, change: { scope: "narrower" } },
    ]);
    expect(send("engine", [{ op: "record_result", result: result("late") }]).ok).toBe(true);
    expect(claimView(p.state, "claim")?.verdict).toEqual({ verdict: "unexplored" });
  });

  it("warns, but does not invalidate, through hypothetical links", () => {
    send("engine", [{ op: "record_result", result: result("r1") }]);
    send("agent", [
      { op: "add_edge", edge: { from: "model", to: "q", origin: "model", state: "hypothetical" } },
    ]);
    const v = resultView(p.state, p.state.results.get("r1")!);
    expect(v.currency).toBe("current");
    expect(v.warnings).toEqual(["relies on hypothetical link model -> q"]);
  });
});

describe("write gate", () => {
  const rejects = (actor: Actor, ops: Op[], code: string, extra: Partial<Command> = {}) => {
    const before = snapshot(p);
    const r = send(actor, ops, extra);
    expect(r).toMatchObject({ ok: false, code });
    expect(snapshot(p)).toBe(before);
  };

  it("rejects attempts to manipulate the record", () => {
    send("engine", [{ op: "record_result", result: result("r1") }]);
    rejects("agent", [{ op: "record_result", result: result("fake") }], "forbidden");
    rejects("human", [{ op: "delete_result", id: "r1" }], "forbidden");
    rejects("engine", [{ op: "edit_result", result: result("r1") }], "forbidden");
    rejects("human", [{ op: "edit_invariant", id: "positivity" }], "forbidden");
    rejects("human", [{ op: "edit_claim", id: "claim" }], "forbidden");
    rejects("agent", [{ op: "set_verdict", claim: "claim", verdict: "holds" }], "forbidden");
  });

  it("keeps agents to proposals", () => {
    rejects(
      "agent",
      [{ op: "add_node", node: { ...nodes.qssa, id: "a2" } as NewNode }],
      "forbidden",
    );
    rejects(
      "agent",
      [{ op: "add_node", node: { ...nodes.positivity, id: "i2" } as NewNode }],
      "forbidden",
    );
    rejects(
      "agent",
      [{ op: "set_assumption", id: "qssa", expectedRevision: 1, change: { state: "adopted" } }],
      "forbidden",
    );
    rejects("agent", [{ op: "confirm_edge", from: "claim", to: "qssa" }], "forbidden");
    rejects(
      "agent",
      [{ op: "add_edge", edge: { from: "model", to: "q", origin: "model", state: "confirmed" } }],
      "invalid_input",
    );
    rejects(
      "agent",
      [{ op: "add_edge", edge: { from: "exp", to: "q", origin: "spec", state: "confirmed" } }],
      "forbidden",
    );
  });

  it("requires a person to approve changes to protected assumptions", () => {
    const op: Op = {
      op: "set_assumption",
      id: "q",
      expectedRevision: 1,
      change: { statement: "q = 1e-4" },
    };
    rejects("human", [op], "needs_approval");
    rejects("agent", [op], "invalid_input", { approved: true });
    expect(send("human", [op], { approved: true }).ok).toBe(true);
  });

  it("keeps claim versions immutable and linked", () => {
    const v2 = {
      ...nodes.claim,
      id: "claim2",
      version: 2,
      supersedes: { id: "claim", revision: 1 },
    } as NewNode;
    rejects("agent", [{ op: "add_node", node: { ...v2, version: 3 } as NewNode }], "invalid_input");
    expect(send("agent", [{ op: "add_node", node: v2 }]).ok).toBe(true);
    expect(p.state.nodes.get("claim")).toMatchObject({ version: 1, revision: 1 });
  });

  it("validates claims against the contract", () => {
    const bad = { ...nodes.claim, id: "bad", predicate: { ...region, ic: "anywhere" } } as NewNode;
    rejects("agent", [{ op: "add_node", node: bad }], "invalid_input");
  });

  it("rejects stale commands, revision conflicts and cycles", () => {
    rejects(
      "human",
      [{ op: "set_assumption", id: "qssa", expectedRevision: 1, change: {} }],
      "stale_base",
      { baseHead: 0 },
    );
    rejects(
      "human",
      [{ op: "set_assumption", id: "qssa", expectedRevision: 5, change: {} }],
      "conflict",
    );
    rejects(
      "human",
      [{ op: "add_edge", edge: { from: "qssa", to: "exp", origin: "human", state: "confirmed" } }],
      "invalid_input",
    );
  });

  it("applies a command completely or not at all", () => {
    rejects(
      "engine",
      [
        { op: "record_result", result: result("ok") },
        { op: "delete_result", id: "ok" },
      ],
      "forbidden",
    );
    expect(p.state.results.has("ok")).toBe(false);
  });

  it("is idempotent by command id", () => {
    const cmd: Command = {
      commandId: "same",
      actor: "engine",
      baseHead: p.state.head,
      ops: [{ op: "record_result", result: result("r1") }],
    };
    const first = p.submit(cmd, "t1");
    const again = p.submit(cmd, "t2");
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(first.ok && again.ok && again.event.seq === first.event.seq).toBe(true);
    expect(
      p.submit({ ...cmd, ops: [{ op: "record_result", result: result("r9") }] }, "t3"),
    ).toMatchObject({ ok: false, code: "duplicate_command" });
  });
});

describe("replay", () => {
  beforeEach(() => {
    send("engine", [{ op: "record_result", result: result("r1") }]);
    send("human", [
      { op: "set_assumption", id: "qssa", expectedRevision: 1, change: { state: "off" } },
    ]);
  });

  it("rebuilds exactly the same state", () => {
    const r = Project.replay(contract, p.events);
    expect(r.ok && snapshot(r.project)).toBe(snapshot(p));
    expect(r.ok && r.project.state.lastHash).toBe(p.state.lastHash);
  });

  it("detects a tampered event", () => {
    const events = structuredClone([...p.events]);
    events[2]!.at = "2030-01-01T00:00:00Z";
    expect(Project.replay(contract, events)).toMatchObject({
      ok: false,
      seq: 3,
      detail: "hash mismatch",
    });
  });

  it("detects a rewritten history against the trusted head hash", () => {
    const trusted = p.state.lastHash;
    const q = new Project(contract);
    for (const e of p.events.slice(0, 2))
      q.submit(
        {
          commandId: e.commandId,
          actor: e.actor,
          baseHead: q.state.head,
          ops: e.ops,
          approved: e.approved,
        },
        e.at,
      );
    const r = Project.replay(contract, q.events);
    expect(r.ok && r.project.state.lastHash).not.toBe(trusted);
  });
});

describe("gate fuzzing", () => {
  // Deterministic generator so failures reproduce from the seed.
  const rng = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

  it("never corrupts the state and always replays", () => {
    let accepted = 0;
    const actors: Actor[] = ["human", "agent", "engine", "engine"];
    for (let seed = 1; seed <= 20; seed++) {
      const rand = rng(seed);
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
      const ids = ["qssa", "q", "model", "claim", "exp", "positivity", "nope", "r1"];
      for (let i = 0; i < 60; i++) {
        const ops: Op[] = [
          {
            op: "record_result",
            result: result(
              `r${String(i)}`,
              pick([
                {},
                { claim: { id: pick(ids), revision: 1 } },
                { assumptions: [{ id: pick(ids), revision: Math.floor(rand() * 3) }] },
              ]),
            ),
          },
          {
            op: "set_assumption",
            id: rand() < 0.6 ? "qssa" : pick(ids),
            expectedRevision:
              rand() < 0.6 ? (p.state.nodes.get("qssa")?.revision ?? 1) : Math.floor(rand() * 4),
            change: { state: pick(["off", "adopted", "hypothetical"] as const) },
          },
          {
            op: "add_edge",
            edge: {
              from: pick(ids),
              to: pick(ids),
              origin: pick(["human", "model", "spec"] as const),
              state: pick(["confirmed", "hypothetical"] as const),
            },
          },
          { op: "delete_result", id: pick(ids) },
          {
            op: "add_node",
            node: {
              ...nodes.qssa,
              id: rand() < 0.5 ? `n${String(i)}` : pick(ids),
              state: pick(["off", "adopted", "hypothetical"] as const),
            } as NewNode,
          },
        ];
        const before = snapshot(p);
        const recorded = new Set(p.state.results.keys());
        const r = send(pick(actors), [pick(ops), ...(rand() < 0.3 ? [pick(ops)] : [])], {
          approved: rand() < 0.2,
          baseHead: rand() < 0.1 ? 0 : p.state.head,
        });
        if (!r.ok) expect(snapshot(p)).toBe(before);
        else accepted++;
        for (const id of recorded) expect(p.state.results.has(id)).toBe(true);
      }
      const replayed = Project.replay(contract, p.events);
      expect(replayed.ok && snapshot(replayed.project)).toBe(snapshot(p));
      p = new Project(contract);
      send(
        "human",
        Object.values(nodes).map((node) => ({ op: "add_node", node })),
        { approved: true },
      );
    }
    // The run must exercise acceptance too, not only rejection.
    expect(accepted).toBeGreaterThan(150);
  });
});

describe("malformed input fuzzing", () => {
  const rng = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

  // One structural mutation somewhere in a JSON value.
  function mutate(value: unknown, rand: () => number): unknown {
    const copy = structuredClone(value) as Record<string, unknown>;
    const holders: Record<string, unknown>[] = [];
    const walk = (v: unknown) => {
      if (v !== null && typeof v === "object") {
        holders.push(v as Record<string, unknown>);
        Object.values(v).forEach(walk);
      }
    };
    walk(copy);
    const target = holders[Math.floor(rand() * holders.length)]!;
    const keys = Object.keys(target);
    const key = keys[Math.floor(rand() * keys.length)] ?? "x";
    const junk = [null, 0, -1, 1.5, "", "op", [], {}, true, "x".repeat(30_000)];
    const r = rand();
    if (r < 0.3) Reflect.deleteProperty(target, key);
    else if (r < 0.5) target[`extra${String(Math.floor(rand() * 3))}`] = 1;
    else target[key] = junk[Math.floor(rand() * junk.length)];
    return copy;
  }

  it("rejects malformed commands without throwing or changing anything", () => {
    const valid = [
      { commandId: "m", actor: "engine", ops: [{ op: "record_result", result: result("rm") }] },
      {
        commandId: "m",
        actor: "human",
        ops: [{ op: "set_assumption", id: "qssa", expectedRevision: 1, change: { state: "off" } }],
      },
      {
        commandId: "m",
        actor: "agent",
        ops: [{ op: "add_node", node: { ...nodes.qssa, id: "h", state: "hypothetical" } }],
      },
    ];
    for (let seed = 1; seed <= 400; seed++) {
      const rand = rng(seed);
      const cmd = {
        ...valid[seed % valid.length]!,
        commandId: `m${String(seed)}`,
        baseHead: p.state.head,
      };
      const before = snapshot(p);
      const input = mutate(cmd, rand);
      let r: ReturnType<Project["submit"]> | undefined;
      expect(() => (r = p.submit(input, "t"))).not.toThrow();
      if (r && !r.ok) expect(snapshot(p)).toBe(before);
    }
    const replayed = Project.replay(contract, p.events);
    expect(replayed.ok && snapshot(replayed.project)).toBe(snapshot(p));
  });
});
