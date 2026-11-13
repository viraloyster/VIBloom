import { describe, expect, it } from "vitest";
import { parseMap } from "./map.ts";
import { addFound, findInvariants } from "./scan.ts";

const SOURCE = `
contract Handler { function invariant_notHere() public {} }
contract CounterTest is Test {
    function setUp() public {}
    function invariant_totalMatchesAdded() public view {}
    function invariantBounded() external view {}
    function test_add() public {}
}`;

describe("scan", () => {
  it("finds invariant functions and the contract each belongs to", () => {
    expect(findInvariants("test/C.t.sol", SOURCE)).toEqual([
      { file: "test/C.t.sol", contract: "Handler", name: "invariant_notHere" },
      { file: "test/C.t.sol", contract: "CounterTest", name: "invariant_totalMatchesAdded" },
      { file: "test/C.t.sol", contract: "CounterTest", name: "invariantBounded" },
    ]);
  });

  it("adds only what the map does not list, as protected invariants with unique ids", () => {
    const start = parseMap({
      version: 1,
      nodes: [
        {
          id: "inv.total-matches-added",
          kind: "invariant",
          title: "already here",
          test: { file: "test/C.t.sol", name: "invariant_totalMatchesAdded" },
        },
      ],
    });
    if (!start.ok) throw new Error(start.errors.join());
    const found = [
      ...findInvariants("test/C.t.sol", SOURCE),
      { file: "test/D.t.sol", contract: "D", name: "invariant_totalMatchesAdded" },
    ];
    const { map, added } = addFound(start.map, found);
    expect(added).toEqual(["inv.not-here", "inv.bounded", "inv.total-matches-added-2"]);
    expect(map.nodes.at(-1)).toMatchObject({
      kind: "invariant",
      protected: true,
      test: { file: "test/D.t.sol", contract: "D", name: "invariant_totalMatchesAdded" },
    });
    expect(parseMap(JSON.parse(JSON.stringify({ version: 1, nodes: [] }))).ok).toBe(true);
  });
});
