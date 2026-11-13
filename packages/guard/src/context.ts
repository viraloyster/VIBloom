// What an agent reads before touching code: full detail for the nodes the file
// at hand touches and the nodes they rest on, one line for everything else.

import { label, troubled, type NodeView } from "./derive.ts";
import { covers } from "./map.ts";

const stateOf = (v: NodeView | undefined) => (v ? label(v) : "?");

const line = (v: NodeView) => `- ${v.id} [${label(v)}] ${v.title}`;

function full(v: NodeView, byId: Map<string, NodeView>): string {
  const out = [line(v)];
  if (v.detail) out.push(`  ${v.detail}`);
  if (v.testFile) out.push(`  test: ${v.testFile}${v.protected ? " (protected)" : ""}`);
  if (v.watch.length) out.push(`  watches: ${v.watch.join(", ")}`);
  if (v.dependsOn.length) {
    out.push(`  rests on: ${v.dependsOn.map((d) => `${d} [${stateOf(byId.get(d))}]`).join(", ")}`);
  }
  if (v.because.length) out.push(`  because of: ${v.because.join(", ")}`);
  if (v.changed.length) out.push(`  changed since run ${String(v.run)}: ${v.changed.join(", ")}`);
  if (v.reason) out.push(`  last failure: ${v.reason}`);
  return out.join("\n");
}

export function context(views: readonly NodeView[], path?: string): string {
  const byId = new Map(views.map((v) => [v.id, v]));
  const near = new Set<string>();
  if (path) {
    for (const v of views) if (v.watch.some((w) => covers(w, path))) near.add(v.id);
    // What the touched nodes rest on, and what rests on them.
    const queue = [...near];
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      for (const d of byId.get(id)?.dependsOn ?? []) {
        if (!near.has(d)) {
          near.add(d);
          queue.push(d);
        }
      }
    }
    for (const v of views) if (v.dependsOn.some((d) => near.has(d))) near.add(v.id);
  }
  const trouble = views.filter(troubled);
  const out: string[] = [
    "VIBloom roots. States are derived from test runs; an agent cannot set them.",
    `${String(views.length)} nodes, ${String(trouble.length)} need attention.`,
  ];
  if (path) {
    out.push("", `Touching ${path}:`);
    const close = views.filter((v) => near.has(v.id));
    out.push(
      ...(close.length ? close.map((v) => full(v, byId)) : ["- nothing in the map watches it"]),
    );
  }
  const rest = views.filter((v) => !near.has(v.id));
  const order = [...rest.filter(troubled), ...rest.filter((v) => !troubled(v))];
  if (order.length) out.push("", path ? "Elsewhere:" : "All nodes:", ...order.map(line));
  out.push(
    "",
    "Rules: propose new assumptions as hypothetical; do not weaken or edit protected tests;",
    "a task is not done while any node is BROKEN, UNSUPPORTED, AT RISK or pending review.",
  );
  return out.join("\n");
}
