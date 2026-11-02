import { describe, expect, it } from "vitest";
import reference from "../fixtures/reference.json";
import { jacobianMismatch } from "./jacobian";
import { resample, solve, type OdeSystem } from "./solver";

const robertson: OdeSystem = {
  rhs: ([a = 0, b = 0, c = 0]) => [
    -0.04 * a + 1e4 * b * c,
    0.04 * a - 1e4 * b * c - 3e7 * b * b,
    3e7 * b * b,
  ],
  jac: ([, b = 0, c = 0]) => [
    [-0.04, 1e4 * c, 1e4 * b],
    [0.04, -1e4 * c - 6e7 * b, -1e4 * b],
    [0, 6e7 * b, 0],
  ],
};

const VDP_EPS = 1e-3;
const vanDerPol: OdeSystem = {
  rhs: ([u = 0, v = 0]) => [v, ((1 - u * u) * v - u) / VDP_EPS],
  jac: ([u = 0, v = 0]) => [
    [0, 1],
    [(-2 * u * v - 1) / VDP_EPS, (1 - u * u) / VDP_EPS],
  ],
};

const systems: Record<string, OdeSystem> = { robertson, van_der_pol: vanDerPol };

const final = (sys: OdeSystem, y0: number[], t1: number, rtol: number) => {
  const tr = solve(sys, y0, t1, { rtol, atol: 1e-14 });
  expect(tr.execution).toEqual({ status: "completed" });
  expect(tr.t[tr.t.length - 1]).toBe(t1);
  return tr.y[tr.y.length - 1] ?? [];
};

describe("solve against SciPy Radau", () => {
  for (const p of reference.problems) {
    const sys = systems[p.name];
    if (!sys) throw new Error(`no system for ${p.name}`);

    it(`matches ${p.name}`, () => {
      p.times.forEach((t1, i) => {
        const got = final(sys, p.y0, t1, 1e-9);
        const want = p.values[i] ?? [];
        want.forEach((w, k) => {
          expect(Math.abs((got[k] ?? NaN) - w)).toBeLessThan(1e-6 * Math.abs(w) + 1e-12);
        });
      });
    });

    it(`has a consistent Jacobian for ${p.name}`, () => {
      expect(jacobianMismatch(sys, p.y0)).toBeLessThan(1e-6);
      expect(jacobianMismatch(sys, [0.7, 1e-5, 0.3].slice(0, p.y0.length))).toBeLessThan(1e-6);
    });
  }

  it("converges as the tolerance tightens", () => {
    const want = reference.problems[0]?.values[2] ?? [];
    const errAt = (rtol: number) =>
      Math.abs((final(robertson, [1, 0, 0], 40, rtol)[0] ?? NaN) - (want[0] ?? NaN));
    expect(errAt(1e-9)).toBeLessThan(errAt(1e-5));
  });
});

describe("resample", () => {
  const tr = solve({ rhs: ([y = 0]) => [-y], jac: () => [[-1]] }, [1], 1, {
    rtol: 1e-8,
    atol: 1e-12,
  });

  it("samples a uniform grid", () => {
    const s = resample(tr, 0, 0.25);
    expect(s.t).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(s.v[4]).toBeCloseTo(Math.exp(-1), 6);
  });

  it("rejects arguments that would not terminate or do not exist", () => {
    for (const dt of [0, -1, NaN, Infinity, 1e-9])
      expect(() => resample(tr, 0, dt)).toThrow(RangeError);
    for (const comp of [-1, 1, 0.5]) expect(() => resample(tr, comp, 0.1)).toThrow(RangeError);
  });
});

describe("solve reports failures explicitly", () => {
  const decay: OdeSystem = { rhs: ([y = 0]) => [-y], jac: () => [[-1]] };

  it("stops when the step budget is exhausted", () => {
    const tr = solve(decay, [1], 10, { rtol: 1e-8, atol: 1e-12, maxSteps: 3 });
    expect(tr.execution).toEqual({ status: "failed", reason: "budget_exhausted" });
    expect(tr.stats.steps).toBe(3);
  });

  it("never exceeds the evaluation budget", () => {
    for (const maxRhsEvals of [1, 15, 16, 17, 100, 1000]) {
      const tr = solve(decay, [1], 10, { rtol: 1e-8, atol: 1e-12, maxRhsEvals });
      expect(tr.stats.rhsEvals).toBeLessThanOrEqual(maxRhsEvals);
    }
  });

  it("rejects invalid options", () => {
    const ok = { rtol: 1e-8, atol: 1e-12 };
    const bad: Array<[number[], number, object]> = [
      [[], 1, ok],
      [[1], 0, ok],
      [[1], Infinity, ok],
      [[1], 1, { ...ok, rtol: 0 }],
      [[1], 1, { ...ok, rtol: NaN }],
      [[1], 1, { ...ok, atol: -1 }],
      [[1], 1, { ...ok, hmax: 0 }],
      [[1], 1, { ...ok, columns: 1 }],
      [[1], 1, { ...ok, maxSteps: 1.5 }],
    ];
    for (const [y0, t1, opt] of bad) {
      expect(() => solve(decay, y0, t1, { ...ok, ...opt })).toThrow(RangeError);
    }
  });

  it("rejects states outside the domain instead of clipping them", () => {
    const sys: OdeSystem = { ...decay, inDomain: ([y = 0]) => y >= 0.5 };
    const tr = solve(sys, [1], 2, { rtol: 1e-8, atol: 1e-12 });
    expect(tr.execution).toEqual({ status: "failed", reason: "domain_exit" });
    expect(tr.y.every(([y = 0]) => y >= 0.5)).toBe(true);
  });

  it("refuses an initial state outside the domain", () => {
    const sys: OdeSystem = { ...decay, inDomain: ([y = 0]) => y >= 0 };
    expect(solve(sys, [-1], 1, { rtol: 1e-8, atol: 1e-12 }).execution).toEqual({
      status: "failed",
      reason: "domain_exit",
    });
  });

  it("does not integrate through a blow-up", () => {
    const blowUp: OdeSystem = { rhs: ([y = 0]) => [y * y], jac: ([y = 0]) => [[2 * y]] };
    const tr = solve(blowUp, [1], 2, { rtol: 1e-8, atol: 1e-12 });
    expect(tr.execution).toMatchObject({ status: "failed" });
    expect(tr.t[tr.t.length - 1]).toBeLessThan(1.001);
  });

  it("reports a singular system", () => {
    // A Jacobian without finite entries cannot be factored at any step size.
    const sys: OdeSystem = { rhs: () => [Infinity], jac: () => [[NaN]] };
    expect(solve(sys, [1], 1, { rtol: 1e-8, atol: 1e-12 }).execution).toEqual({
      status: "failed",
      reason: "singular_system",
    });
  });

  it("rejects a non-finite initial state", () => {
    expect(solve(decay, [NaN], 1, { rtol: 1e-8, atol: 1e-12 }).execution).toEqual({
      status: "failed",
      reason: "non_finite",
    });
  });
});
