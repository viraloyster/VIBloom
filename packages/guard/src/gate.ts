// The check before a commit. It works with any agent, any editor and no AI at
// all: whoever commits goes through it.

import { label, troubled, type NodeView } from "./derive.ts";
import type { Role } from "./hooks.ts";
import { guarded } from "./hooks.ts";
import { covers, LOG_PATH, type RootsMap } from "./map.ts";

export interface GateResult {
  ok: boolean;
  problems: string[];
}

export function precommit(
  map: RootsMap,
  views: readonly NodeView[],
  staged: readonly string[],
  role: Role,
  logProblems: readonly string[],
): GateResult {
  const problems: string[] = [];
  if (role !== "verifier") {
    // The log is appended by `vibloom run`; its integrity is checked below
    // rather than by who changed it.
    const paths = guarded(map);
    for (const f of staged) {
      if (f !== LOG_PATH && paths.some((g) => covers(g, f))) {
        problems.push(`${f} is guarded: only VIBLOOM_ROLE=verifier may commit changes to it`);
      }
    }
  }
  for (const p of logProblems) problems.push(`run log: ${p}`);
  // Before a commit, an invariant that never ran counts too: nothing says it holds.
  const blocking = (v: NodeView) =>
    troubled(v) || (v.stance !== "off" && v.kind === "invariant" && v.evidence === "untested");
  for (const v of views.filter(blocking)) {
    const why = v.changed.length
      ? `changed since run ${String(v.run)}: ${v.changed.join(", ")}`
      : v.reason
        ? `failure: ${v.reason}`
        : v.because.length
          ? `because of ${v.because.join(", ")}`
          : "";
    problems.push(`${v.id} [${label(v)}] ${v.title}${why ? `; ${why}` : ""}`);
  }
  return { ok: problems.length === 0, problems };
}
