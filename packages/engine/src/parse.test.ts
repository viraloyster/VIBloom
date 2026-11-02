import { describe, expect, it } from "vitest";
import { parseCommand } from "./parse";

const base = { commandId: "c1", actor: "agent", baseHead: 0 };
const assumption = {
  kind: "assumption",
  id: "a",
  title: "A",
  statement: "s",
  scope: "all",
  state: "hypothetical",
  protected: false,
};
const ok = { ...base, ops: [{ op: "add_node", node: assumption }] };

const detail = (input: unknown) => {
  const r = parseCommand(input);
  return r.ok ? "ok" : r.detail;
};

describe("parseCommand", () => {
  it("accepts a well formed command and detaches it from the input", () => {
    const input = structuredClone(ok);
    const r = parseCommand(input);
    expect(r.ok).toBe(true);
    input.ops[0]!.node.title = "changed";
    expect(r.ok && r.command.ops[0]).toMatchObject({ node: { title: "A" } });
  });

  it.each([
    ["not an object", "command", "$: must be an object"],
    ["an unknown actor", { ...ok, actor: "root" }, "$.actor: must be one of human, agent, engine"],
    ["an unknown field", { ...ok, sudo: true }, "$.sudo: unknown field"],
    ["a negative head", { ...ok, baseHead: -1 }, "$.baseHead: must be an integer >= 0"],
    [
      "an unknown operation",
      { ...base, ops: [{ op: "drop_table" }] },
      "$.ops[0].op: unknown operation",
    ],
    [
      "an unknown node kind",
      { ...base, ops: [{ op: "add_node", node: { kind: "oracle", id: "x", title: "X" } }] },
      "$.ops[0].node.kind: unknown node kind",
    ],
    [
      "an extra node field",
      { ...base, ops: [{ op: "add_node", node: { ...assumption, revision: 9 } }] },
      "$.ops[0].node.revision: unknown field",
    ],
    [
      "a wrong field type",
      { ...base, ops: [{ op: "add_node", node: { ...assumption, protected: "no" } }] },
      "$.ops[0].node.protected: must be a boolean",
    ],
    [
      "a change of an immutable field",
      {
        ...base,
        ops: [{ op: "set_assumption", id: "a", expectedRevision: 1, change: { protected: false } }],
      },
      "$.ops[0].change.protected: unknown field",
    ],
    [
      "a non-finite parameter",
      {
        ...base,
        ops: [
          {
            op: "add_node",
            node: {
              kind: "model",
              id: "m",
              title: "M",
              name: "m",
              version: "1",
              equations: "e",
              params: { q: Infinity },
              scaling: "t",
            },
          },
        ],
      },
      "$.ops[0].node.params.q: must be a finite number",
    ],
    [
      "an unknown failure reason",
      {
        ...base,
        ops: [
          {
            op: "record_result",
            result: {
              id: "r",
              experiment: { id: "e", revision: 1 },
              claim: { id: "c", revision: 1 },
              assumptions: [],
              execution: { status: "failed", reason: "bad_luck" },
            },
          },
        ],
      },
      "$.ops[0].result.execution.reason: must be one of budget_exhausted, step_too_small, singular_system, non_finite, domain_exit",
    ],
  ])("rejects %s", (_name, input, expected) => {
    expect(detail(input)).toBe(expected);
  });
});
