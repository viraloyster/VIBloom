import { describe, expect, it } from "vitest";
import type { NodeView } from "./derive.ts";
import { postTool, preTool, stop } from "./hooks.ts";
import { parseMap, type RootsMap } from "./map.ts";

const map = (): RootsMap => {
  const r = parseMap({
    version: 1,
    protect: ["foundry.toml"],
    nodes: [
      {
        id: "inv.sum",
        kind: "invariant",
        title: "sum",
        test: { file: "test/C.t.sol", name: "invariant_sum" },
        watch: ["src/C.sol"],
      },
      {
        id: "inv.open",
        kind: "invariant",
        title: "unprotected",
        test: { file: "test/Open.t.sol", name: "invariant_open" },
        protected: false,
      },
    ],
  });
  if (!r.ok) throw new Error(r.errors.join());
  return r.map;
};

const rel = (p: string) => p.replace(/^\/repo\//, "");

const view = (over: Partial<NodeView>): NodeView => ({
  id: "inv.sum",
  kind: "invariant",
  title: "sum",
  stance: "adopted",
  protected: true,
  evidence: "holds",
  support: "ok",
  because: [],
  changed: [],
  dependsOn: [],
  watch: ["src/C.sol", "test/C.t.sol"],
  testFile: "test/C.t.sol",
  ...over,
});

const parsed = (o: { stdout?: string }) => JSON.parse(o.stdout ?? "{}") as Record<string, unknown>;

const added = (o: Record<string, unknown>) =>
  String((o.hookSpecificOutput as { additionalContext?: unknown } | undefined)?.additionalContext);

describe("preTool", () => {
  const edit = (file_path: string) => ({ tool_name: "Edit", tool_input: { file_path } });

  it("denies a builder editing a protected test, the map, the log or a protected path", () => {
    for (const p of [
      "/repo/test/C.t.sol",
      "/repo/.vibloom/roots.json",
      "/repo/.vibloom/log.jsonl",
      "/repo/foundry.toml",
    ]) {
      const out = parsed(preTool(edit(p), map(), "builder", rel));
      expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    }
  });

  it("lets the builder edit code and unprotected tests, and the verifier edit anything", () => {
    expect(preTool(edit("/repo/src/C.sol"), map(), "builder", rel).stdout).toBeUndefined();
    expect(preTool(edit("/repo/test/Open.t.sol"), map(), "builder", rel).stdout).toBeUndefined();
    expect(preTool(edit("/repo/test/C.t.sol"), map(), "verifier", rel).stdout).toBeUndefined();
  });

  it("denies shell commands that write to a guarded path, not ones that only read it", () => {
    const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
    expect(
      parsed(preTool(bash("sed -i 's/a/b/' test/C.t.sol"), map(), "builder", rel)),
    ).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(
      parsed(preTool(bash("echo {} > .vibloom/roots.json"), map(), "builder", rel)),
    ).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(preTool(bash("cat test/C.t.sol"), map(), "builder", rel).stdout).toBeUndefined();
  });
});

describe("postTool", () => {
  const run = { tool_name: "Bash", tool_input: { command: "forge test --mt invariant_sum" } };

  it("sends the agent back after a test run that broke something", () => {
    const out = parsed(postTool(run, [view({ evidence: "broken", reason: "drift" })], rel));
    expect(out.decision).toBe("block");
    expect(String(out.reason)).toMatch(/inv\.sum \[BROKEN\] sum; failure: drift/);
    expect(String(out.reason)).toMatch(/Fix the code, not the invariant/);
  });

  it("only adds context after a clean run", () => {
    const out = parsed(postTool(run, [view({})], rel));
    expect(out.decision).toBeUndefined();
    expect(added(out)).toMatch(/1 tested nodes hold/);
  });

  it("warns when an edit touches a watched file", () => {
    const out = parsed(
      postTool(
        { tool_name: "Write", tool_input: { file_path: "/repo/src/C.sol" } },
        [view({})],
        rel,
      ),
    );
    expect(added(out)).toMatch(/pending review/);
    expect(
      postTool(
        { tool_name: "Write", tool_input: { file_path: "/repo/README.md" } },
        [view({})],
        rel,
      ).stdout,
    ).toBeUndefined();
  });
});

describe("stop", () => {
  it("blocks finishing while a node needs attention, once", () => {
    const bad = [view({ evidence: "stale", changed: ["src/C.sol"] })];
    expect(parsed(stop({}, bad)).decision).toBe("block");
    const again = parsed(stop({ stop_hook_active: true }, bad));
    expect(again.decision).toBeUndefined();
    expect(String(again.systemMessage)).toMatch(/1 nodes that need attention/);
  });

  it("lets a clean task finish, and blocks a tampered log", () => {
    expect(stop({}, [view({})]).stdout).toBeUndefined();
    expect(
      parsed(stop({}, [view({})], ["entry 1 was changed after it was written"])).decision,
    ).toBe("block");
  });
});
