import { describe, expect, it } from "vitest";
import { jacobianMismatch } from "./jacobian";
import {
  FIELD_2007,
  fullModel,
  initialState,
  reducedModel,
  steadyStateX,
  type OregonatorParams,
} from "./oregonator";

const params: OregonatorParams[] = [
  { ...FIELD_2007, s: 1 },
  { ...FIELD_2007, eps_prime: 1e-3, s: 0.6 },
  { ...FIELD_2007, s: 2.5 },
];

describe("Oregonator models", () => {
  it.each(params)("have consistent Jacobians (s = $s, eps_prime = $eps_prime)", (p) => {
    for (const ic of ["far", "mid", "near"] as const) {
      expect(jacobianMismatch(fullModel(p), initialState("full", p, ic))).toBeLessThan(1e-6);
      expect(jacobianMismatch(reducedModel(p), initialState("reduced", p, ic))).toBeLessThan(1e-6);
    }
  });

  it.each(params)("share the steady state (s = $s)", (p) => {
    const x = steadyStateX(p);
    const y = (p.s * x) / (p.q + x);
    const rf = fullModel(p).rhs([x, y, x]);
    const rr = reducedModel(p).rhs([x, x]);
    for (const v of [...rf, ...rr]) expect(Math.abs(v)).toBeLessThan(1e-9);
  });

  it("start the full model on the slow manifold", () => {
    const p = params[0]!;
    for (const ic of ["far", "mid", "near"] as const) {
      const [x = 0, z = 0] = initialState("reduced", p, ic);
      expect(initialState("full", p, ic)).toEqual([x, (p.s * z) / (p.q + x), z]);
      expect(fullModel(p).rhs(initialState("full", p, ic))[1]).toBeCloseTo(0, 9);
    }
  });

  it("treat negative concentrations as outside the domain", () => {
    const p = params[0]!;
    expect(fullModel(p).inDomain?.([0.1, 0.1, 0.1])).toBe(true);
    expect(fullModel(p).inDomain?.([0.1, -1e-15, 0.1])).toBe(false);
    expect(reducedModel(p).inDomain?.([-1e-15, 0.1])).toBe(false);
  });
});
