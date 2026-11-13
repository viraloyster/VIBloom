// Decisions for Claude Code hooks. Each takes the hook's input and what the
// guard knows, and returns what to print and how to exit. No IO here.

import { label, troubled, type NodeView } from "./derive.ts";
import { forgeFilters } from "./forge.ts";
import { covers, type RootsMap } from "./map.ts";

export type Role = "builder" | "verifier";

export interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string; command?: string };
  stop_hook_active?: boolean;
  cwd?: string;
}

export interface HookOutput {
  exit: 0 | 2;
  stdout?: string;
  stderr?: string;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Paths only the verifier may change: protected tests, the protect list and
// the guard's own map and log.
export function guarded(map: RootsMap): string[] {
  const tests = map.nodes.flatMap((n) => (n.protected && n.test ? [n.test.file] : []));
  return [...new Set([".vibloom/", ...map.protect, ...tests])];
}

const isGuarded = (map: RootsMap, rel: string) => guarded(map).some((g) => covers(g, rel));

// Shell commands that plainly write to a file: redirection, in-place edits,
// moves, deletes, copies. A heuristic, not a sandbox.
const WRITES = /(^|[\s;&|])(>|>>|tee\b|sed\s+-i|perl\s+-i|rm\b|mv\b|cp\b|truncate\b|dd\b)/;

export function preTool(
  input: HookInput,
  map: RootsMap,
  role: Role,
  rel: (p: string) => string | undefined,
): HookOutput {
  if (role === "verifier") return { exit: 0 };
  const name = input.tool_name ?? "";
  const deny = (reason: string): HookOutput => ({
    exit: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  });
  if (EDIT_TOOLS.has(name)) {
    const p = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    const r = p ? rel(p) : undefined;
    if (r !== undefined && isGuarded(map, r)) {
      return deny(
        `VIBloom: ${r} is guarded. Only the verifier role may change protected tests and the roots map. ` +
          "If the test is wrong, say so and explain why; do not change it to make it pass.",
      );
    }
  }
  if (name === "Bash") {
    const cmd = input.tool_input?.command ?? "";
    const hit = guarded(map).find((g) => cmd.includes(g.replace(/\/$/, "")));
    if (hit && WRITES.test(cmd)) {
      return deny(`VIBloom: this command looks like it writes to ${hit}, which is guarded.`);
    }
  }
  return { exit: 0 };
}

function summary(views: readonly NodeView[]): string {
  const bad = views.filter(troubled);
  return bad
    .map((v) => {
      const parts = [`${v.id} [${label(v)}] ${v.title}`];
      if (v.reason) parts.push(`failure: ${v.reason}`);
      if (v.because.length) parts.push(`because of ${v.because.join(", ")}`);
      if (v.changed.length) parts.push(`changed: ${v.changed.join(", ")}`);
      return `- ${parts.join("; ")}`;
    })
    .join("\n");
}

// After a tool ran. `views` is the state after the guard re-ran the tests, when
// the tool was a test run.
export function postTool(
  input: HookInput,
  views: readonly NodeView[],
  rel: (p: string) => string | undefined,
): HookOutput {
  const name = input.tool_name ?? "";
  const context = (text: string): HookOutput => ({
    exit: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text },
    }),
  });
  if (name === "Bash" && forgeFilters(input.tool_input?.command ?? "")) {
    const bad = views.filter(troubled);
    if (!bad.length) {
      const held = views.filter((v) => v.evidence === "holds").length;
      return context(
        `VIBloom: recorded the run; ${String(held)} tested nodes hold, none need attention.`,
      );
    }
    return {
      exit: 0,
      stdout: JSON.stringify({
        decision: "block",
        reason:
          `VIBloom recorded the run. ${String(bad.length)} nodes need attention:\n${summary(views)}\n` +
          "Fix the code, not the invariant. If you believe an invariant or assumption is wrong, " +
          "stop and explain why instead of changing it.",
      }),
    };
  }
  if (EDIT_TOOLS.has(name)) {
    const p = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    const r = p ? rel(p) : undefined;
    if (r === undefined) return { exit: 0 };
    const hit = views.filter((v) => v.watch.some((w) => covers(w, r)));
    if (!hit.length) return { exit: 0 };
    return context(
      `VIBloom: ${r} is watched by ${hit.map((v) => v.id).join(", ")}. ` +
        "Their evidence is now pending review; run the tests before calling this done.",
    );
  }
  return { exit: 0 };
}

export function stop(
  input: HookInput,
  views: readonly NodeView[],
  logProblems: readonly string[] = [],
): HookOutput {
  if (logProblems.length) {
    return {
      exit: 0,
      stdout: JSON.stringify({
        decision: "block",
        reason: `VIBloom: the run log failed verification:\n- ${logProblems.join("\n- ")}\nThe record may only be appended by the guard. Tell the person.`,
      }),
    };
  }
  const bad = views.filter(troubled);
  if (!bad.length) return { exit: 0 };
  // Claude Code sets this when a Stop hook already sent the agent back once;
  // letting it stop then avoids a loop, and the state stays visible.
  if (input.stop_hook_active) {
    return {
      exit: 0,
      stdout: JSON.stringify({
        systemMessage: `VIBloom: stopping with ${String(bad.length)} nodes that need attention.`,
      }),
    };
  }
  return {
    exit: 0,
    stdout: JSON.stringify({
      decision: "block",
      reason:
        `VIBloom: the task is not done. ${String(bad.length)} nodes need attention:\n${summary(views)}\n` +
        "Run the tests again after fixing the code, or explain why a node is wrong.",
    }),
  };
}
