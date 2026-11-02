import { describe, expect, it } from "vitest";
import { parseDecision } from "./decisions";

const run = {
  action: "run_point",
  experiment: "point-runs",
  point: { s: 1.8 },
  distinguishes: ["the reduction fails only near onset", "it fails everywhere"],
  prediction: { outcome: "holds", because: "far from onset the bromide relaxes fast" },
  rationale: "test the middle of the region first",
  cites: ["reduction-keeps-period"],
};

const detail = (input: unknown) => {
  const r = parseDecision(input);
  return r.ok ? "ok" : r.detail;
};

describe("parseDecision", () => {
  it("accepts a well formed decision", () => {
    expect(detail(run)).toBe("ok");
    expect(
      detail({
        action: "conclude",
        claim: "c",
        verdict: "refuted",
        results: ["r1"],
        limits: "one point, far initial condition",
        interpretation: "slow bromide lengthens the cycle",
        rationale: "r",
        cites: [],
      }),
    ).toBe("ok");
  });

  it.each([
    ["an unknown action", { ...run, action: "delete_everything" }, "$.action: unknown action"],
    ["an extra field", { ...run, verdict: "holds" }, "$.verdict: unknown field"],
    ["a missing prediction", { ...run, prediction: undefined }, "$.prediction: must be an object"],
    [
      "a prediction outside the vocabulary",
      { ...run, prediction: { outcome: "maybe", because: "x" } },
      "$.prediction.outcome: must be one of holds, fails",
    ],
    [
      "one explanation only",
      { ...run, distinguishes: ["a"] },
      "$.distinguishes: must name exactly two explanations",
    ],
    [
      "a non-slug experiment id",
      { ...run, experiment: "Point Runs" },
      "$.experiment: must be a lowercase slug",
    ],
    ["a missing rationale", { ...run, rationale: "" }, "$.rationale: must be a non-empty string"],
  ])("rejects %s", (_name, input, expected) => {
    expect(detail(input)).toBe(expected);
  });
});
