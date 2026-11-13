import { describe, expect, it } from "vitest";
import { parseMap, serializeMap } from "./map.ts";

const inv = (id: string, extra: object = {}) => ({
  id,
  kind: "invariant",
  title: id,
  test: { file: "test/A.t.sol", name: `invariant_${id.replace(/\W/g, "_")}()` },
  ...extra,
});

describe("parseMap", () => {
  it("fills defaults: invariants adopted and protected, assumptions hypothetical", () => {
    const r = parseMap({
      version: 1,
      nodes: [inv("inv.a"), { id: "asm.b", kind: "assumption", title: "b", depends_on: ["inv.a"] }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [a, b] = r.map.nodes;
    expect(a).toMatchObject({
      stance: "adopted",
      protected: true,
      test: { name: "invariant_inv_a" },
    });
    expect(b).toMatchObject({ stance: "hypothetical", protected: false, dependsOn: ["inv.a"] });
    expect(r.map.runner).toEqual(["forge", "test", "--json"]);
  });

  it("rejects unknown dependencies and duplicate ids", () => {
    const r = parseMap({
      version: 1,
      nodes: [
        inv("inv.a"),
        inv("inv.a"),
        { id: "asm.d", kind: "assumption", title: "d", depends_on: ["nope"] },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual(["inv.a: duplicate id", "asm.d: depends on unknown nope"]);
  });

  it("rejects a dependency cycle", () => {
    const r = parseMap({
      version: 1,
      nodes: [
        inv("inv.a", { depends_on: ["asm.c"] }),
        { id: "asm.c", kind: "assumption", title: "c", depends_on: ["inv.a"] },
      ],
    });
    expect(r).toEqual({ ok: false, errors: ["dependency cycle: inv.a -> asm.c -> inv.a"] });
  });

  it("rejects paths that leave the repository and invariants without a test", () => {
    const r = parseMap({
      version: 1,
      nodes: [
        { id: "inv.x", kind: "invariant", title: "x" },
        { id: "asm.y", kind: "assumption", title: "y", watch: ["../secret"] },
        { id: "asm.z", kind: "assumption", title: "z", watch: ["/etc/passwd"] },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual(
      expect.arrayContaining([
        "inv.x: an invariant needs a test",
        "asm.y: watch must list relative paths",
        "asm.z: watch must list relative paths",
      ]),
    );
  });

  it("round-trips through serializeMap", () => {
    const first = parseMap({
      version: 1,
      protect: ["foundry.toml"],
      nodes: [inv("inv.a", { watch: ["src/"], detail: "why" })],
    });
    if (!first.ok) throw new Error(first.errors.join());
    const again = parseMap(JSON.parse(serializeMap(first.map)));
    expect(again).toEqual(first);
  });
});
