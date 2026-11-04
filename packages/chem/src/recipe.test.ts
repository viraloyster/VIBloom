import { describe, expect, it } from "vitest";
import { FIELD_2007 } from "./oregonator";
import { fromRecipe, RATE_CONSTANTS } from "./recipe";

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

describe("a real recipe", () => {
  it("reproduces the scaled parameters of the cited recipe", () => {
    const p = fromRecipe({ bromate: 0.06, malonic_acid: 0.02, acid: 0.8 });
    expect(rel(p.q, FIELD_2007.q)).toBeLessThan(1e-3);
    expect(rel(p.eps, FIELD_2007.eps)).toBeLessThan(5e-3);
    expect(rel(p.eps_prime, FIELD_2007.eps_prime)).toBeLessThan(5e-3);
    expect(p.time_scale_s).toBeCloseTo(50);
  });

  it("uses Field's constants at the reference acidity", () => {
    const at = (c: { k: number; protons: number }, h: number) => c.k * h ** c.protons;
    expect(at(RATE_CONSTANTS.k2, 0.8)).toBeCloseTo(2.4e6);
    expect(at(RATE_CONSTANTS.k4, 0.8)).toBeCloseTo(2400);
    expect(at(RATE_CONSTANTS.k3, 0.8)).toBeCloseTo(33.6);
    expect(at(RATE_CONSTANTS.k1, 0.8)).toBeCloseTo(1.28);
  });

  it("changes with acidity as Field's rate laws imply, and refuses an impossible recipe", () => {
    const base = fromRecipe({ bromate: 0.06, malonic_acid: 0.02, acid: 0.8 });
    const acid = fromRecipe({ bromate: 0.06, malonic_acid: 0.02, acid: 1.6 });
    // Doubling the acid: q doubles, eps and eps_prime halve, seconds stay.
    expect(rel(acid.q, base.q * 2)).toBeLessThan(1e-12);
    expect(rel(acid.eps, base.eps / 2)).toBeLessThan(1e-12);
    expect(rel(acid.eps_prime, base.eps_prime / 2)).toBeLessThan(1e-12);
    expect(acid.time_scale_s).toBeCloseTo(base.time_scale_s);
    expect(() => fromRecipe({ bromate: 0, malonic_acid: 0.02, acid: 0.8 })).toThrow(/bromate/);
  });
});

describe("a trace for drawing", () => {
  it("covers the requested periods after the start has settled", async () => {
    const { trace } = await import("./trace");
    const p = { ...FIELD_2007, s: 1, eps_prime: 2e-4 };
    const tr = trace("full", p, 11.545);
    expect(tr).toBeDefined();
    expect(tr?.t[0]).toBeCloseTo(0, 1);
    expect(tr?.t.at(-1)).toBeGreaterThan(30);
    // It oscillates: x swings over decades.
    const x = tr?.x ?? [];
    expect(Math.log10(Math.max(...x) / Math.min(...x))).toBeGreaterThan(1);
  });
});
