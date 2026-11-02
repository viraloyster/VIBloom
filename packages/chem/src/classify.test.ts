import { describe, expect, it } from "vitest";
import reference from "../fixtures/reference.json";
import { PROTOCOL, classify, peaks, read, type ModelPoint } from "./classify";
import { BRIZARD_BERRY_2021, FIELD_2007, type OregonatorModel } from "./oregonator";

const grid = (end: number, dt = 1 / 40) => Array.from({ length: end / dt + 1 }, (_, i) => i * dt);
const spikes = (t: number[], period: number, later = period) =>
  t.map((s) => 10 ** (-3 + 2 * Math.sin((2 * Math.PI * s) / (s < 150 ? period : later))));
const flat = (t: number[]) => t.map(() => 0.02);

describe("read", () => {
  it("measures the period of a regular oscillation", () => {
    const t = grid(100);
    const r = read(t, spikes(t, 7.3), 1e-3);
    expect(r.kind).toBe("oscillation");
    expect(r.kind === "oscillation" && Math.abs(r.period - 7.3) / 7.3).toBeLessThan(1e-4);
  });

  it("recognises a steady state only at the fixed point", () => {
    const t = grid(100);
    expect(read(t, flat(t), 0.02)).toEqual({ kind: "steady_state" });
    expect(read(t, flat(t), 0.03)).toEqual({ kind: "need_longer" });
  });

  it("does not call an irregular signal an oscillation", () => {
    const t = grid(200);
    const r = read(t, spikes(t, 5, 11), 1e-3);
    expect(r.kind).toBe("irregular");
  });

  it("asks for a longer horizon when too few peaks are seen", () => {
    const t = grid(40);
    const r = read(t, spikes(t, 9), 1e-3);
    expect(r.kind).toBe("need_longer");
  });

  it("reads the longest window the protocol can produce", () => {
    const end = 2 * PROTOCOL.maxBaseHorizon;
    const t = grid(end);
    const r = read(t, spikes(t, 9), 1e-3);
    expect(r.kind).toBe("oscillation");
  });

  it("finds peaks by prominence", () => {
    expect(peaks([0, 2, 0, 1.5, 1.4, 1.6, 0, 3, 0], 1)).toEqual([1, 5, 7]);
  });
});

describe("classify against SciPy Radau", () => {
  for (const c of reference.oregonator) {
    const point: ModelPoint = {
      model: c.model as OregonatorModel,
      params: c.params,
      ic: "far",
    };
    it(`matches the ${c.model} period at s = ${String(c.params.s)}, eps = ${String(c.params.eps)}, eps_prime = ${String(c.params.eps_prime)}`, () => {
      const got = classify(point);
      expect(got.observation).toBe("oscillation");
      expect(Math.abs((got.period ?? NaN) - c.period) / c.period).toBeLessThan(5e-4);
    });
  }
});

describe("classify", () => {
  it("finds the steady state above the oscillatory range", () => {
    expect(classify({ model: "full", params: { ...FIELD_2007, s: 3 }, ic: "far" })).toMatchObject({
      observation: "steady_state",
      execution: { status: "completed" },
    });
  });

  it("separates coexisting attractors by initial condition", () => {
    const params = { ...FIELD_2007, eps_prime: 1e-4, s: 2.2 };
    expect(classify({ model: "full", params, ic: "far" }).observation).toBe("oscillation");
    expect(classify({ model: "full", params, ic: "near" }).observation).toBe("steady_state");
  });

  it("records the three runs of the protocol", () => {
    const c = classify({ model: "reduced", params: { ...FIELD_2007, s: 1 }, ic: "far" });
    const last = c.runs.slice(-3);
    expect(last.map((r) => r.horizon)).toEqual([c.horizon, c.horizon, 2 * c.horizon]);
    expect(last[1]!.rtol).toBeLessThan(last[0]!.rtol);
  });
});

describe("Brizard and Berry (2021), s = 1", () => {
  // Their periods are in fast time t; this package uses tau = d t.
  const fast = (model: OregonatorModel) =>
    (classify({ model, params: { ...BRIZARD_BERRY_2021, s: 1 }, ic: "far" }).period ?? NaN) /
    BRIZARD_BERRY_2021.eps;

  it("reproduces the Oregonator-2 period of 7110 within 0.5%", () => {
    expect(Math.abs(fast("reduced") - 7110) / 7110).toBeLessThan(5e-3);
  });

  it("reproduces the Oregonator-3 period of 7160 within 0.5%", () => {
    expect(Math.abs(fast("full") - 7160) / 7160).toBeLessThan(5e-3);
  });
});
