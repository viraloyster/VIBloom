import { describe, expect, it } from "vitest";
import { parseClaim, validateClaim, type Contract } from "./claims";

const contract: Contract = {
  version: "test",
  models: { full: { params: ["s", "eps_prime"] }, reduced: { params: ["s"] } },
  domain: {
    s: { min: 0.4, max: 2.8, scale: "linear" },
    eps_prime: { min: 1e-6, max: 1e-2, scale: "log" },
  },
  initialConditions: ["far", "mid", "near"],
};

const region = {
  kind: "FOR_ALL",
  region: { s: { min: 0.6, max: 2.3 } },
  fixed: { eps_prime: 1.98e-5 },
  ic: "far",
  body: { kind: "AGREE_AND_PERIOD_WITHIN", reference: "full", reduced: "reduced", tolerance: 0.05 },
};

const withoutIc = Object.fromEntries(Object.entries(region).filter(([k]) => k !== "ic"));

const messages = (input: unknown) =>
  validateClaim(contract, input).map((p) => `${p.path}: ${p.message}`);

describe("validateClaim", () => {
  it("accepts well formed claims", () => {
    expect(messages(region)).toEqual([]);
    expect(messages({ kind: "OSCILLATES", model: "reduced", point: { s: 1 }, ic: "mid" })).toEqual(
      [],
    );
    expect(
      messages({
        kind: "PERIOD_WITHIN",
        reference: "full",
        reduced: "reduced",
        point: { s: 1, eps_prime: 1e-4 },
        ic: "near",
        tolerance: 0.01,
      }),
    ).toEqual([]);
  });

  it.each([
    ["an unknown field", { ...region, note: "trust me" }, "$.note: unknown field"],
    ["a missing field", withoutIc, "$.ic: missing field"],
    [
      "an unknown initial condition",
      { ...region, ic: "anywhere" },
      "$.ic: unknown initial condition",
    ],
    [
      "a range outside the domain",
      { ...region, region: { s: { min: 0.6, max: 5 } } },
      "$.region.s: outside admissible domain [0.4, 2.8]",
    ],
    [
      "an inverted range",
      { ...region, region: { s: { min: 2, max: 1 } } },
      "$.region.s: needs numeric min < max",
    ],
    [
      "a parameter outside the contract",
      { ...region, fixed: { eps_prime: 1e-5, temperature: 300 } },
      "$.fixed.temperature: parameter not in contract",
    ],
    ["an unset parameter", { ...region, fixed: {} }, "$: parameter eps_prime is not set"],
    [
      "a parameter both fixed and swept",
      { ...region, fixed: { eps_prime: 1e-5, s: 1 } },
      "$.fixed.s: both fixed and swept",
    ],
    [
      "a bare period comparison over a region",
      { ...region, body: { ...region.body, kind: "PERIOD_WITHIN" } },
      "$.body.kind: unknown region body; use AGREE_AND_PERIOD_WITHIN for periods",
    ],
    [
      "a tolerance that is not a fraction",
      { ...region, body: { ...region.body, tolerance: 5 } },
      "$.body.tolerance: must be a fraction in (0, 1)",
    ],
    [
      "a model compared with itself",
      { ...region, body: { ...region.body, reduced: "full" } },
      "$.body.reduced: must differ from reference",
    ],
    ["an unknown claim kind", { kind: "PROVES_TRUTH" }, "$.kind: unknown claim kind"],
    [
      "a non-finite value",
      { kind: "OSCILLATES", model: "reduced", point: { s: Number.NaN }, ic: "far" },
      "$.point.s: must be a finite number",
    ],
    [
      "a parameter the model does not use",
      { kind: "OSCILLATES", model: "reduced", point: { s: 1, eps_prime: 1e-4 }, ic: "far" },
      "$.point.eps_prime: not a parameter of the models",
    ],
    [
      "an inherited key used as a model",
      { kind: "OSCILLATES", model: "toString", point: { s: 1 }, ic: "far" },
      "$.model: unknown model",
    ],
  ])("rejects %s", (_name, input, expected) => {
    expect(messages(input)).toContain(expected);
  });

  it("rejects values that are not objects", () => {
    for (const input of [null, [], "claim", 1])
      expect(messages(input)).toEqual(["$: must be an object"]);
  });
});

describe("parseClaim", () => {
  it("returns the typed claim or the problems", () => {
    const ok = parseClaim(contract, region);
    expect(ok.ok && ok.claim.kind).toBe("FOR_ALL");
    const bad = parseClaim(contract, { ...region, ic: "anywhere" });
    expect(bad.ok).toBe(false);
  });
});
