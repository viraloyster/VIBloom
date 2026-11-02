import { ReplayProvider, ScriptedProvider, type TurnRequest } from "@vibloom/agent";
import type { Event } from "@vibloom/engine";
import { describe, expect, it } from "vitest";
import { DEMO_OPS } from "./seed";
import {
  ProjectService,
  type EventStore,
  type InvestigationStore,
  type StoredInvestigation,
} from "./service";

class MemoryStore implements EventStore {
  rows: string[] = [];
  all(): Event[] {
    return this.rows.map((r) => JSON.parse(r) as Event);
  }
  append(e: Event) {
    this.rows.push(JSON.stringify(e));
  }
}

class MemoryInvestigations implements InvestigationStore {
  rows: StoredInvestigation[] = [];
  all() {
    return structuredClone(this.rows);
  }
  count() {
    return this.rows.length;
  }
  append(r: StoredInvestigation) {
    this.rows.push(structuredClone(r));
  }
}

let tick = 0;
const clock = () => `2026-11-02T12:00:${String(tick++).padStart(2, "0")}Z`;
const CLAIM = "reduction-keeps-period";

const demo = (s: ProjectService) =>
  s.command({ commandId: "demo", baseHead: s.view().head, ops: DEMO_OPS }, false);
const verdict = (s: ProjectService) => s.view().claims.find((c) => c?.claim === CLAIM)?.verdict;

describe("vertical slice", () => {
  it("runs a point, refutes the claim, invalidates on change and replays", () => {
    const store = new MemoryStore();
    const svc = new ProjectService(store, new MemoryInvestigations(), clock);
    expect(svc.seed().ok).toBe(true);
    expect(demo(svc).ok).toBe(true);
    expect(verdict(svc)).toEqual({ verdict: "unexplored" });

    // At s = 1 and eps_prime = 1e-4 the periods differ by about 19%.
    const run = svc.run({ experiment: "reduction-keeps-period-runs", point: { s: 1 } });
    expect(run.ok).toBe(true);
    const v = verdict(svc);
    expect(v?.verdict).toBe("refuted");

    const result = svc.view().results[0]!;
    expect(result.record.basis.map((b) => b.id)).toEqual(
      expect.arrayContaining(["field-parameters", "quasi-steady-bromide", "oregonator"]),
    );

    // The refutation stays on record; it stops counting once its basis is gone.
    const head = svc.view().head;
    const off = svc.command(
      {
        commandId: "off",
        baseHead: head,
        ops: [
          {
            op: "set_assumption",
            id: "quasi-steady-bromide",
            expectedRevision: 1,
            change: { state: "off" },
          },
        ],
      },
      false,
    );
    expect(off.ok).toBe(true);
    expect(verdict(svc)).toEqual({ verdict: "unexplored" });
    expect(svc.view().results[0]?.view.currency).toBe("unsupported");

    // A fresh service over the same store rebuilds the same project.
    const again = new ProjectService(store, new MemoryInvestigations(), clock);
    expect(again.view().lastHash).toBe(svc.view().lastHash);
    expect(again.verify()).toMatchObject({ ok: true, events: 4 });
  });

  it("never lets a request body choose its actor or approve itself", () => {
    const svc = new ProjectService(new MemoryStore(), new MemoryInvestigations(), clock);
    svc.seed();
    const head = svc.view().head;
    const forged = svc.command(
      {
        commandId: "forged",
        baseHead: head,
        actor: "engine",
        approved: true,
        ops: [
          {
            op: "set_assumption",
            id: "field-parameters",
            expectedRevision: 1,
            change: { statement: "q = 1" },
          },
        ],
      },
      false,
    );
    expect(forged).toMatchObject({ ok: false, code: "needs_approval" });
  });

  it("rejects points outside the claim region", () => {
    const svc = new ProjectService(new MemoryStore(), new MemoryInvestigations(), clock);
    svc.seed();
    demo(svc);
    expect(svc.run({ experiment: "reduction-keeps-period-runs", point: { s: 2.6 } })).toMatchObject(
      {
        ok: false,
        code: "invalid_input",
      },
    );
    expect(
      svc.run({ experiment: "reduction-keeps-period-runs", point: { s: 1, eps_prime: 1e-3 } }),
    ).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  it("refuses to start from a tampered log", () => {
    const store = new MemoryStore();
    const svc = new ProjectService(store, new MemoryInvestigations(), clock);
    svc.seed();
    store.rows[0] = store.rows[0]!.replace("7.62e-5", "7.63e-5");
    expect(() => new ProjectService(store, new MemoryInvestigations(), clock)).toThrow(/replay/);
  });
});

describe("investigation", () => {
  const goal = "Does removing the bromide variable keep the period of the oscillations?";
  const script = [
    {
      action: "formulate",
      question: goal,
      ambiguities: ["'keep' is read as: same oscillation and period within 5%"],
      claims: [
        {
          id: "bromide-free-period",
          title: "The reduced model keeps the period",
          text: "For s in [0.6, 2.3] at eps_prime = 1e-4, periods agree within 5%.",
          predicate: {
            kind: "FOR_ALL",
            region: { s: { min: 0.6, max: 2.3 } },
            fixed: { eps_prime: 1e-4 },
            ic: "far",
            body: {
              kind: "AGREE_AND_PERIOD_WITHIN",
              reference: "full",
              reduced: "reduced",
              tolerance: 0.05,
            },
          },
        },
      ],
      assumptions: [
        {
          id: "fast-bromide",
          title: "Bromide relaxes fast",
          statement: "eps_prime is small enough for y to follow x and z",
          scope: "reduced model",
        },
      ],
      dependencies: [{ from: "bromide-free-period", to: "fast-bromide", reason: "the reduction" }],
      rationale: "make the question testable",
      cites: ["oregonator"],
    },
    {
      action: "run_point",
      experiment: "bromide-free-period-runs",
      point: { s: 1 },
      distinguishes: ["the reduction is exact enough", "slow bromide shifts the period"],
      prediction: { outcome: "holds", because: "eps_prime is two orders below eps" },
      rationale: "start in the middle of the region",
      cites: ["bromide-free-period"],
    },
    (r: TurnRequest) => ({
      action: "conclude",
      summary: "At s = 1 the periods differ by about 19%, so the 5% claim fails.",
      surprise: "eps_prime = 1e-4 is not small enough; the bromide lag lengthens the cycle",
      rationale: "one counterexample refutes a region claim",
      cites: (JSON.parse(r.context) as { results: { id: string }[] }).results.map((x) => x.id),
    }),
  ];

  it("lets the model drive: formulate, predict, get surprised, conclude", async () => {
    const svc = new ProjectService(new MemoryStore(), new MemoryInvestigations(), clock);
    svc.seed();
    // The conclusion must cite the result, whose id the engine assigns.
    const provider = new ScriptedProvider(script);
    const first = await svc.investigate(goal, provider);
    expect(first.ok && first.investigation.investigation.stop).toBe("concluded");

    const trace = first.ok ? first.investigation.investigation.trace : [];
    expect(trace[1]?.prediction).toEqual({
      predicted: "holds",
      observed: "fails",
      verdict: "surprise",
    });
    expect(svc.view().claims.find((c) => c?.claim === "bromide-free-period")?.verdict.verdict).toBe(
      "refuted",
    );
  });

  it("replays a recorded investigation exactly on a fresh project", async () => {
    const make = () => new ProjectService(new MemoryStore(), new MemoryInvestigations(), clock);
    const live = make();
    live.seed();
    const recorded = await live.investigate(goal, new ScriptedProvider(script));
    if (!recorded.ok) throw new Error("investigation failed");

    const again = make();
    again.seed();
    const replayed = await again.investigate(
      goal,
      new ReplayProvider(recorded.investigation.recording),
    );
    if (!replayed.ok) throw new Error("replay failed");
    const strip = (r: StoredInvestigation) =>
      r.investigation.trace.map((t) => ({ ...t, usage: undefined }));
    expect(strip(replayed.investigation)).toEqual(strip(recorded.investigation));
    expect(again.view().lastHash).not.toBe("");
  });

  it("refuses an empty goal", async () => {
    const svc = new ProjectService(new MemoryStore(), new MemoryInvestigations(), clock);
    svc.seed();
    expect(await svc.investigate("  ", new ScriptedProvider([]))).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });
});
