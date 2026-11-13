import { describe, expect, it } from "vitest";
import { forgeFilters, parseForge, RunnerOutputError } from "./forge.ts";

// The shape `forge test --json` prints (Foundry 1.7), trimmed to what is read.
const REPORT = {
  "test/Counter.t.sol:CounterTest": {
    duration: "1ms",
    test_results: {
      "invariant_totalMatchesAdded()": { status: "Failure", reason: "total drifted: 1 != 0" },
      "invariant_totalBounded()": { status: "Success", reason: null },
      "test_skipMe()": { status: "Skipped", reason: null },
    },
    warnings: [],
  },
};

describe("parseForge", () => {
  it("reads every result, keeping status and reason", () => {
    const out = parseForge(`Compiling...\n${JSON.stringify(REPORT)}\n`);
    expect(out).toEqual([
      {
        file: "test/Counter.t.sol",
        contract: "CounterTest",
        name: "invariant_totalMatchesAdded",
        status: "fail",
        reason: "total drifted: 1 != 0",
      },
      {
        file: "test/Counter.t.sol",
        contract: "CounterTest",
        name: "invariant_totalBounded",
        status: "pass",
      },
      { file: "test/Counter.t.sol", contract: "CounterTest", name: "test_skipMe", status: "skip" },
    ]);
  });

  it("fails loudly when there is no report, as when compilation fails", () => {
    expect(() => parseForge("Error: Compiler run failed:\nError (2314)")).toThrow(
      RunnerOutputError,
    );
  });
});

describe("forgeFilters", () => {
  it("keeps the subset a test command asked for", () => {
    expect(forgeFilters("forge test --match-path test/A.t.sol -vvv")).toEqual([
      "--match-path",
      "test/A.t.sol",
    ]);
    expect(forgeFilters("cd x && forge test --mt=invariant_a --mc 'Foo' | tail")).toEqual([
      "--mt",
      "invariant_a",
      "--mc",
      "Foo",
    ]);
    expect(forgeFilters("forge test")).toEqual([]);
  });

  it("ignores commands that are not a test run", () => {
    expect(forgeFilters("forge build")).toBeUndefined();
    expect(forgeFilters("echo forge")).toBeUndefined();
  });
});
