import { describe, expect, it } from "vitest";
import { halton, radicalInverse, rotation } from "./halton";
import { search, type Outcome, type Point, type SearchPlan } from "./search";

const plan = (over: Partial<SearchPlan> = {}): SearchPlan => ({
  dims: [{ name: "s", min: 0.6, max: 2.3, scale: "linear" }],
  budget: 24,
  seed: 7,
  reference: { s: 1.0 },
  ...over,
});

// The claim fails above s = 1.7.
const threshold = (p: Point): Outcome => ((p.s ?? 0) > 1.7 ? "fails" : "holds");

describe("halton", () => {
  it("follows the radical inverse", () => {
    expect([1, 2, 3].map((i) => radicalInverse(i, 2))).toEqual([0.5, 0.25, 0.75]);
    expect(radicalInverse(1, 3)).toBeCloseTo(1 / 3, 12);
  });

  it("is reproducible from the seed and stays in the unit cube", () => {
    expect(rotation(7, 3)).toEqual(rotation(7, 3));
    expect(rotation(7, 3)).not.toEqual(rotation(8, 3));
    for (let i = 1; i < 200; i++) {
      for (const x of halton(i, 2, rotation(1, 2))) expect(x >= 0 && x < 1).toBe(true);
    }
  });
});

describe("search", () => {
  it("finds a counterexample and reduces it toward the reference", () => {
    const r = search(plan(), threshold);
    expect(r.region.status).toBe("counterexample_found");
    expect(r.evaluated).toHaveLength(24);
    // Reduced to just past the boundary, never beyond it.
    expect(r.reduced?.point.s).toBeGreaterThan(1.7);
    expect(r.reduced?.point.s).toBeLessThan(1.72);
    expect(r.reduced?.distance).toBeLessThan(Math.abs((r.reduced?.from.s ?? 0) - 1.0) / 1.7 + 1e-9);
    expect(threshold(r.reduced?.point ?? {})).toBe("fails");
  });

  it("reports no counterexample without claiming the region holds", () => {
    const r = search(plan(), () => "holds");
    expect(r.region).toEqual({ status: "no_counterexample", evaluated: 24, inconclusive: 0 });
    expect(r.reduced).toBeUndefined();
  });

  it("never shrinks across points the protocol could not classify", () => {
    const banded = (p: Point): Outcome => {
      const s = p.s ?? 0;
      return s > 1.9 ? "fails" : s > 1.5 ? "inconclusive" : "holds";
    };
    const r = search(plan(), banded);
    expect(r.reduced?.stopped).toBe("inconclusive_zone");
    expect(r.reduced?.point.s).toBeGreaterThan(1.9);
  });

  it("is reproducible from the seed", () => {
    expect(search(plan(), threshold)).toEqual(search(plan(), threshold));
    expect(search(plan({ seed: 8 }), threshold).evaluated[0]).not.toEqual(
      search(plan(), threshold).evaluated[0],
    );
  });

  it("samples log-scaled dimensions inside their range", () => {
    const r = search(
      plan({
        dims: [{ name: "eps_prime", min: 1e-6, max: 1e-2, scale: "log" }],
        reference: { eps_prime: 1e-5 },
      }),
      () => "holds",
    );
    for (const e of r.evaluated) {
      expect(e.point.eps_prime).toBeGreaterThanOrEqual(1e-6);
      expect(e.point.eps_prime).toBeLessThanOrEqual(1e-2);
    }
  });

  it("leaves a region unexplored when nothing could be classified", () => {
    expect(search(plan(), () => "inconclusive").region).toEqual({ status: "unexplored" });
  });

  it("rejects bad plans", () => {
    expect(() => search(plan({ budget: 0 }), threshold)).toThrow(RangeError);
    expect(() => search(plan({ dims: [] }), threshold)).toThrow(RangeError);
    expect(() =>
      search(plan({ dims: [{ name: "x", min: 0, max: 1, scale: "log" }] }), threshold),
    ).toThrow(RangeError);
  });
});
