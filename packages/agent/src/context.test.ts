import type { Contract } from "@vibloom/contracts";
import { Project, type Op } from "@vibloom/engine";
import { describe, expect, it } from "vitest";
import { renderContext } from "./context";

const contract: Contract = {
  version: "test",
  models: { m: { params: ["s"] } },
  domain: { s: { min: 0, max: 1, scale: "linear" } },
  initialConditions: ["far"],
};

// A chain a0 <- a1 <- ... <- a(n-1): each assumption rests on the previous one,
// plus many unrelated assumptions.
function project(chain: number, unrelated: number) {
  const p = new Project(contract);
  const ops: Op[] = [];
  const add = (id: string) =>
    ops.push({
      op: "add_node",
      node: {
        kind: "assumption",
        id,
        title: `Assumption ${id}`,
        statement:
          `A long statement about ${id} that the model only needs when it is close. `.repeat(3),
        scope: "test",
        state: "adopted",
        protected: false,
      },
    });
  for (let i = 0; i < chain; i++) add(`a${String(i)}`);
  for (let i = 0; i < unrelated; i++) add(`u${String(i)}`);
  for (let i = 1; i < chain; i++) {
    ops.push({
      op: "add_edge",
      edge: { from: `a${String(i)}`, to: `a${String(i - 1)}`, origin: "human", state: "confirmed" },
    });
  }
  // Commands carry at most 200 operations.
  for (let i = 0; i < ops.length; i += 150) {
    const r = p.submit(
      { commandId: `c${String(i)}`, actor: "human", baseHead: p.head, ops: ops.slice(i, i + 150) },
      "t",
    );
    expect(r.ok).toBe(true);
  }
  return p.state;
}

type Entry = { id: string; path: string; level: string; statement?: string };
const entries = (ctx: string) =>
  Object.values((JSON.parse(ctx) as { tree: Record<string, Entry[]> }).tree).flat();

describe("layered context", () => {
  it("gives every root in full when nothing is selected", () => {
    const all = entries(renderContext(project(5, 5)));
    expect(all.every((e) => e.level === "details")).toBe(true);
    expect(all.map((e) => e.path)).toContain("assumptions/a0");
  });

  it("shapes detail by distance from the selected root", () => {
    const s = project(8, 0);
    const byId = new Map(entries(renderContext(s, "a7")).map((e) => [e.id, e]));
    expect(byId.get("a7")?.level).toBe("details_and_history");
    expect(byId.get("a6")?.level).toBe("details_and_history");
    // Everything the focus rests on is required, so it stays in full however deep.
    expect(byId.get("a0")?.level).toBe("details");
    expect(byId.get("a0")?.statement).toBeDefined();
  });

  it("keeps far roots to a title, so focus costs less than the whole map", () => {
    const s = project(6, 300);
    const focused = renderContext(s, "a5");
    const whole = renderContext(s);
    const far = entries(focused).find((e) => e.id === "u10");
    expect(far).toEqual({
      path: "assumptions/u10",
      id: "u10",
      title: "Assumption u10",
      level: "title",
    });
    expect(focused.length).toBeLessThan(whole.length / 4);
  });
});
