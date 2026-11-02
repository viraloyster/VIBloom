import type { Event } from "@vibloom/engine";
import { describe, expect, it } from "vitest";
import { ProjectService, type EventStore } from "./service";

class MemoryStore implements EventStore {
  rows: string[] = [];
  all(): Event[] {
    return this.rows.map((r) => JSON.parse(r) as Event);
  }
  append(e: Event) {
    this.rows.push(JSON.stringify(e));
  }
}

let tick = 0;
const clock = () => `2026-11-02T12:00:${String(tick++).padStart(2, "0")}Z`;
const CLAIM = "reduction-keeps-period";

const verdict = (s: ProjectService) => s.view().claims.find((c) => c?.claim === CLAIM)?.verdict;

describe("vertical slice", () => {
  it("runs a point, refutes the claim, invalidates on change and replays", () => {
    const store = new MemoryStore();
    const svc = new ProjectService(store, clock);
    expect(svc.seed().ok).toBe(true);
    expect(verdict(svc)).toEqual({ verdict: "unexplored" });

    // At s = 1 and eps_prime = 1e-4 the periods differ by about 19%.
    const run = svc.run({ experiment: "point-runs", point: { s: 1 } });
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
    const again = new ProjectService(store, clock);
    expect(again.view().lastHash).toBe(svc.view().lastHash);
    expect(again.verify()).toMatchObject({ ok: true, events: 3 });
  });

  it("never lets a request body choose its actor or approve itself", () => {
    const svc = new ProjectService(new MemoryStore(), clock);
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
    const svc = new ProjectService(new MemoryStore(), clock);
    svc.seed();
    expect(svc.run({ experiment: "point-runs", point: { s: 2.6 } })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(svc.run({ experiment: "point-runs", point: { s: 1, eps_prime: 1e-3 } })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  it("refuses to start from a tampered log", () => {
    const store = new MemoryStore();
    const svc = new ProjectService(store, clock);
    svc.seed();
    store.rows[0] = store.rows[0]!.replace("7.62e-5", "7.63e-5");
    expect(() => new ProjectService(store, clock)).toThrow(/replay/);
  });
});
