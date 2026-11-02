// Where each root grows. Positions come from the graph and the node ids only,
// so a project keeps the same map as it grows.

import type { DependsOn, RootNode } from "@vibloom/contracts";
import { rng } from "./canopy";

export interface Placed {
  id: string;
  x: number;
  y: number;
  depth: number;
  parent?: string;
}

export interface Layout {
  nodes: Map<string, Placed>;
  // Root paths from the parent (or the trunk) to each node.
  paths: Map<string, string>;
  // Points along each root where decorative rootlets sprout.
  buds: { id: string; x: number; y: number }[];
  height: number;
  // Extra dependencies that the spanning tree did not use.
  links: { from: string; to: string; d: string; state: DependsOn["state"] }[];
}

export const TRUNK = { x: 500, y: 560 } as const;

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

type Pt = [number, number];

function curve(ax: number, ay: number, bx: number, by: number, seed: string): Pt[] {
  const r = rng(hash(seed));
  const sway = (r() - 0.5) * 70;
  return [
    [ax, ay],
    [ax + (bx - ax) * 0.15 + sway, ay + (by - ay) * 0.55],
    [bx - (bx - ax) * 0.25 - sway * 0.5, by - (by - ay) * 0.35],
    [bx, by],
  ];
}

function pointOn(c: Pt[], t: number): Pt {
  const u = 1 - t;
  const [p0, p1, p2, p3] = c as [Pt, Pt, Pt, Pt];
  const f = (i: 0 | 1) =>
    u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i];
  return [f(0), f(1)];
}

const toPath = (c: Pt[]) =>
  `M${c.map(([x, y], i) => `${i === 1 ? "C" : ""}${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}`;

// An organic curve that leaves the parent downward and bends toward the child.
export function rootPath(ax: number, ay: number, bx: number, by: number, seed: string): string {
  return toPath(curve(ax, ay, bx, by, seed));
}

export function layout(nodes: RootNode[], edges: DependsOn[]): Layout {
  const ids = new Set(nodes.map((n) => n.id));
  const deps = new Map<string, string[]>();
  const dependents = new Map<string, number>();
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    deps.set(e.from, [...(deps.get(e.from) ?? []), e.to].sort());
    dependents.set(e.to, (dependents.get(e.to) ?? 0) + 1);
  }
  // What hangs straight from the trunk: nodes nothing depends on.
  const top = nodes
    .filter((n) => !dependents.has(n.id))
    .map((n) => n.id)
    .sort();

  const parent = new Map<string, string | undefined>();
  const children = new Map<string, string[]>();
  const depth = new Map<string, number>();
  const queue = top.map((id) => {
    parent.set(id, undefined);
    depth.set(id, 0);
    return id;
  });
  for (const id of queue) {
    for (const d of deps.get(id) ?? []) {
      if (depth.has(d)) continue;
      parent.set(d, id);
      depth.set(d, (depth.get(id) ?? 0) + 1);
      children.set(id, [...(children.get(id) ?? []), d]);
      queue.push(d);
    }
  }
  // Anything left (cycles of hypothetical links) hangs from the trunk too.
  for (const n of nodes) {
    if (!depth.has(n.id)) {
      depth.set(n.id, 0);
      top.push(n.id);
    }
  }

  // Each subtree gets a horizontal share proportional to its leaves.
  const leaves = new Map<string, number>();
  const count = (id: string): number => {
    const c = children.get(id) ?? [];
    const v = c.length === 0 ? 1 : c.reduce((s, k) => s + count(k), 0);
    leaves.set(id, v);
    return v;
  };
  const total = top.reduce((s, id) => s + count(id), 0) || 1;

  const maxDepth = Math.max(0, ...[...depth.values()]);
  // Rows fill the soil whatever the depth of the project.
  const ROW = Math.min(230, Math.max(130, 820 / (maxDepth + 1)));
  const placed = new Map<string, Placed>();
  const place = (id: string, from: number, to: number, d: number) => {
    const r = rng(hash(id));
    const mid = (from + to) / 2;
    // Deeper roots spread wider than the trunk, as guanacaste roots do.
    const spread = 0.55 + Math.min(0.45, d * 0.15);
    const x = TRUNK.x + (mid - 500) * spread + (r() - 0.5) * 30;
    const y = TRUNK.y + 110 + d * ROW + (r() - 0.5) * 50;
    const p: Placed = { id, x, y, depth: d };
    const par = parent.get(id);
    if (par) p.parent = par;
    placed.set(id, p);
    let at = from;
    for (const c of children.get(id) ?? []) {
      const w = ((to - from) * (leaves.get(c) ?? 1)) / (leaves.get(id) ?? 1);
      place(c, at, at + w, d + 1);
      at += w;
    }
  };
  let at = 0;
  for (const id of top) {
    const w = (1000 * (leaves.get(id) ?? 1)) / total;
    place(id, at, at + w, 0);
    at += w;
  }

  const paths = new Map<string, string>();
  const buds: Layout["buds"] = [];
  for (const p of placed.values()) {
    const from = p.parent ? placed.get(p.parent) : undefined;
    const c = curve(from?.x ?? TRUNK.x, from?.y ?? TRUNK.y, p.x, p.y, p.id);
    paths.set(p.id, toPath(c));
    for (const t of [0.3, 0.55, 0.8]) {
      const [x, y] = pointOn(c, t);
      buds.push({ id: `${p.id}@${String(t)}`, x, y });
    }
  }
  const links: Layout["links"] = [];
  for (const e of edges) {
    const a = placed.get(e.from);
    const b = placed.get(e.to);
    if (!a || !b || b.parent === e.from) continue;
    links.push({
      from: e.from,
      to: e.to,
      state: e.state,
      d: rootPath(a.x, a.y, b.x, b.y, `${e.from}>${e.to}`),
    });
  }
  const height = Math.max(...[...placed.values()].map((p) => p.y), TRUNK.y) + 260;
  return { nodes: placed, paths, links, buds, height };
}

// Decorative rootlets around a point; never selectable, never a dependency.
export function filaments(
  x: number,
  y: number,
  seed: string,
  generations = 3,
  reach = 1,
): string[] {
  const r = rng(hash(`f:${seed}`));
  const out: string[] = [];
  const grow = (sx: number, sy: number, angle: number, len: number, gen: number) => {
    const ex = sx + Math.cos(angle) * len;
    const ey = sy + Math.sin(angle) * len;
    const mx = (sx + ex) / 2 + (r() - 0.5) * len * 0.4;
    const my = (sy + ey) / 2 + (r() - 0.5) * len * 0.4;
    out.push(
      `M${sx.toFixed(1)},${sy.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`,
    );
    if (gen <= 0) return;
    const n = 2 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++)
      grow(ex, ey, angle + (r() - 0.5) * 1.3, len * (0.55 + r() * 0.2), gen - 1);
  };
  const n = 3 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    grow(x, y, Math.PI / 2 + (r() - 0.5) * 2.6, (30 + r() * 34) * reach, generations);
  }
  return out;
}
