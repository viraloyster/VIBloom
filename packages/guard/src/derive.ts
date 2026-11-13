// Every state shown to a person or an agent is derived here, from the map, the
// verified log and the files as they are now. Nothing else can set one.

import type { Outcome } from "./forge.ts";
import type { RunEntry } from "./log.ts";
import { covers, watchedBy, type Kind, type RootNode, type RootsMap, type Stance } from "./map.ts";

// What the node's own test says.
export type Evidence = "holds" | "broken" | "skipped" | "untested" | "stale" | "none";

// What follows from the nodes it depends on.
export type Support = "ok" | "pending" | "unsupported";

export interface NodeView {
  id: string;
  kind: Kind;
  title: string;
  detail?: string;
  stance: Stance;
  protected: boolean;
  evidence: Evidence;
  support: Support;
  // The dependencies that made support pending or unsupported.
  because: string[];
  // Watched files that changed since the run the evidence comes from.
  changed: string[];
  reason?: string;
  run?: number;
  dependsOn: string[];
  watch: string[];
  testFile?: string;
}

const matches = (n: RootNode, o: Outcome): boolean =>
  !!n.test &&
  o.file === n.test.file &&
  o.name === n.test.name &&
  (n.test.contract === undefined || o.contract === n.test.contract);

// Files a node watches, as found in a hash table (the current tree or a run).
function filesOf(n: RootNode, table: Record<string, string | null>): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const w of watchedBy(n)) {
    if (w.endsWith("/")) {
      for (const [f, h] of Object.entries(table)) if (covers(w, f)) out.set(f, h);
    } else {
      out.set(w, table[w] ?? null);
    }
  }
  return out;
}

function changedSince(
  n: RootNode,
  run: RunEntry,
  current: Record<string, string | null>,
): string[] {
  const then = filesOf(n, run.files);
  const now = filesOf(n, current);
  const out = new Set<string>();
  for (const [f, h] of now) {
    // A file the run did not record is treated as changed: its state then is unknown.
    if (!(f in run.files) || then.get(f) !== h) out.add(f);
  }
  for (const f of then.keys()) if (!now.has(f)) out.add(f);
  return [...out].sort();
}

export function derive(
  map: RootsMap,
  entries: readonly RunEntry[],
  current: Record<string, string | null>,
): NodeView[] {
  const own = new Map<string, Pick<NodeView, "evidence" | "changed" | "reason" | "run">>();
  for (const n of map.nodes) {
    if (!n.test) {
      own.set(n.id, { evidence: "none", changed: [] });
      continue;
    }
    let found: { entry: RunEntry; outcome: Outcome } | undefined;
    for (let i = entries.length - 1; i >= 0 && !found; i--) {
      const entry = entries[i];
      const outcome = entry?.outcomes.find((o) => matches(n, o));
      if (entry && outcome) found = { entry, outcome };
    }
    if (!found) {
      own.set(n.id, { evidence: "untested", changed: [] });
      continue;
    }
    const changed = changedSince(n, found.entry, current);
    const s = found.outcome.status;
    // A failure stays a failure until a new run says otherwise; a pass only
    // counts while the files it ran against are unchanged.
    const evidence: Evidence =
      s === "fail" ? "broken" : s === "skip" ? "skipped" : changed.length ? "stale" : "holds";
    const v: Pick<NodeView, "evidence" | "changed" | "reason" | "run"> = {
      evidence,
      changed,
      run: found.entry.seq,
    };
    if (found.outcome.reason) v.reason = found.outcome.reason;
    own.set(n.id, v);
  }

  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const support = new Map<string, { support: Support; because: string[] }>();
  // Weakest link wins: off or broken anywhere below makes a node unsupported;
  // stale evidence below makes it pending review.
  const resolve = (id: string): { support: Support; because: string[] } => {
    const known = support.get(id);
    if (known) return known;
    const n = byId.get(id);
    const res: { support: Support; because: string[] } = { support: "ok", because: [] };
    for (const d of n?.dependsOn ?? []) {
      const dn = byId.get(d);
      const ev = own.get(d)?.evidence;
      const below = resolve(d);
      const bad = dn?.stance === "off" || ev === "broken" || below.support === "unsupported";
      const pending = ev === "stale" || below.support === "pending";
      if (bad) {
        res.support = "unsupported";
        res.because.push(d);
      } else if (pending) {
        if (res.support === "ok") res.support = "pending";
        res.because.push(d);
      }
    }
    support.set(id, res);
    return res;
  };

  return map.nodes.map((n) => {
    const o = own.get(n.id) ?? { evidence: "none" as const, changed: [] };
    const s = resolve(n.id);
    const v: NodeView = {
      id: n.id,
      kind: n.kind,
      title: n.title,
      stance: n.stance,
      protected: n.protected,
      evidence: o.evidence,
      support: s.support,
      because: s.because,
      changed: o.changed,
      dependsOn: n.dependsOn,
      watch: watchedBy(n),
    };
    if (n.detail) v.detail = n.detail;
    if (o.reason) v.reason = o.reason;
    if (o.run !== undefined) v.run = o.run;
    if (n.test) v.testFile = n.test.file;
    return v;
  });
}

// A node needs attention when its own evidence or its support is not sound.
// Off nodes are a choice, not a problem.
export const troubled = (v: NodeView): boolean =>
  v.stance !== "off" && (v.evidence === "broken" || v.evidence === "stale" || v.support !== "ok");

export const label = (v: NodeView): string => {
  if (v.stance === "off") return "off";
  if (v.evidence === "broken") return "BROKEN";
  if (v.support === "unsupported") return v.kind === "intention" ? "AT RISK" : "UNSUPPORTED";
  if (v.evidence === "stale") return "pending review";
  if (v.support === "pending") return "pending review";
  if (v.evidence === "holds") return "holds";
  if (v.evidence === "untested") return "untested";
  if (v.evidence === "skipped") return "skipped";
  return v.stance;
};
