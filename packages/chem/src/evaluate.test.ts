import type { Claim } from "@vibloom/contracts";
import { describe, expect, it } from "vitest";
import { evaluatePoint } from "./evaluate";
import { FIELD_2007 } from "./oregonator";

const fixed = { q: FIELD_2007.q, eps: FIELD_2007.eps };
const agreeAndPeriod = (tolerance: number): Claim => ({
  kind: "FOR_ALL",
  region: { s: { min: 0.6, max: 2.3 } },
  fixed: { eps_prime: 1e-4 },
  ic: "far",
  body: { kind: "AGREE_AND_PERIOD_WITHIN", reference: "full", reduced: "reduced", tolerance },
});

describe("evaluatePoint", () => {
  it("refutes a period claim where the reduction drifts", () => {
    // Full 8.85 vs reduced 7.45 at s = 1, eps_prime = 1e-4: about 19% apart.
    const e = evaluatePoint(agreeAndPeriod(0.05), fixed, { s: 1, eps_prime: 1e-4 }, "far");
    expect(e).toMatchObject({ execution: { status: "completed" }, outcome: "fails" });
    expect(e.runs.full?.period).toBeCloseTo(8.85, 1);
    expect(e.runs.reduced?.period).toBeCloseTo(7.45, 1);
  });

  it("holds with a tolerance wide enough for the drift", () => {
    const e = evaluatePoint(agreeAndPeriod(0.25), fixed, { s: 1, eps_prime: 1e-4 }, "far");
    expect(e.outcome).toBe("holds");
  });

  it("does not compare periods where a model does not oscillate", () => {
    const claim: Claim = {
      kind: "PERIOD_WITHIN",
      reference: "full",
      reduced: "reduced",
      point: { s: 3, eps_prime: 1.98e-5 },
      ic: "far",
      tolerance: 0.05,
    };
    expect(evaluatePoint(claim, fixed, claim.point, "far").outcome).toBe("not_applicable");
  });

  it("evaluates a single-model claim", () => {
    const claim: Claim = { kind: "OSCILLATES", model: "reduced", point: { s: 1 }, ic: "far" };
    expect(evaluatePoint(claim, fixed, { s: 1, eps_prime: 1.98e-5 }, "far").outcome).toBe("holds");
  });
});
