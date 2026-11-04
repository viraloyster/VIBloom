// The idea tree drawn as roots under a guanacaste crown. Each root grows in
// when its node is created; colours come only from the status the code derives.

import type { IdeaNode, IdeaTree, Status } from "@vibloom/ideas";
import { el, svg } from "../dom";
import { rng } from "../canopy";
import { hash } from "../layout";

const DX = 112;
const DY = 165;
const CROWN_W = 600;
const CROWN_H = 316;

export interface Ghost {
  key: string;
  under: string;
  title: string;
}

export interface TreeView {
  render(tree: IdeaTree, ghosts?: Ghost[]): void;
  seed(text: string | undefined): void;
  refit(): void;
  dispose(): void;
  select(id: string | undefined): void;
  focus(id: string): void;
  busy(id: string | undefined): void;
  // Light up the roots a step of the process touched.
  mark(ids: string[]): void;
}

interface Pos {
  x: number;
  y: number;
}

// Leaves get evenly spaced columns; a parent sits over the middle of its children.
function place(tree: IdeaTree, ghosts: Ghost[]): Map<string, Pos> {
  const kids = new Map<string, string[]>();
  for (const n of tree.nodes.values()) {
    if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n.id]);
  }
  for (const g of ghosts) kids.set(g.under, [...(kids.get(g.under) ?? []), `ghost:${g.key}`]);
  const pos = new Map<string, Pos>();
  let column = 0;
  const walk = (id: string, depth: number, nth = 0): number => {
    const c = kids.get(id) ?? [];
    let x: number;
    if (c.length === 0) x = column++ * DX;
    else {
      const xs = c.map((k, i) => walk(k, depth + 1, i));
      x = ((xs[0] ?? 0) + (xs.at(-1) ?? 0)) / 2;
    }
    // Siblings alternate in depth, as real roots do, so a wide level stays narrow.
    pos.set(id, { x, y: depth * DY + (depth > 0 && nth % 2 === 1 ? 52 : 0) });
    return x;
  };
  walk("goal", 0);
  const root = pos.get("goal")?.x ?? 0;
  for (const p of pos.values()) p.x -= root;
  return pos;
}

type Pt = [number, number];

// A root as a filled shape that tapers from parent to child, with a slight
// wander seeded by its id so it keeps the same form on every redraw.
function rootShape(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  seed: string,
  w0: number,
  w1: number,
) {
  const r = rng(hash(seed));
  const sway = (r() - 0.5) * 24;
  // Roots drop together under the parent before they spread, like a real
  // root crown, then curve out to their tips.
  const c: Pt[] = [
    [ax, ay],
    [ax + (bx - ax) * 0.08 + sway, ay + (by - ay) * 0.62],
    [bx - (bx - ax) * 0.35, by - (by - ay) * 0.18 + sway * 0.3],
    [bx, by],
  ];
  const at = (t: number): Pt => {
    const u = 1 - t;
    const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return [0, 1].map((i) => c.reduce((s, p, j) => s + (k[j] ?? 0) * (p[i] ?? 0), 0)) as Pt;
  };
  const pts = Array.from({ length: 19 }, (_, i) => at(i / 18));
  const left: Pt[] = [];
  const right: Pt[] = [];
  pts.forEach((p, i) => {
    const q = pts[Math.min(i + 1, 18)] ?? p;
    const o = pts[Math.max(i - 1, 0)] ?? p;
    const dx = q[0] - o[0];
    const dy = q[1] - o[1];
    const len = Math.hypot(dx, dy) || 1;
    // Slightly knotted, like bark.
    const w = (w0 + (w1 - w0) * (i / 18)) * (1 + 0.12 * Math.sin(i * 1.7 + (r() - 0.5)));
    left.push([p[0] - (dy / len) * w, p[1] + (dx / len) * w]);
    right.push([p[0] + (dy / len) * w, p[1] - (dx / len) * w]);
  });
  const f = ([x, y]: Pt) => `${x.toFixed(1)},${y.toFixed(1)}`;
  const body = `M${left.map(f).join(" L")} L${right.reverse().map(f).join(" L")} Z`;
  const core = `M${pts.map(f).join(" L")}`;
  // A highlight along one flank and a shadow along the other give the root a
  // rounded, lit-from-above look.
  const lit = `M${pts
    .map((p, i) => {
      const q = pts[Math.min(i + 1, 18)] ?? p;
      const o = pts[Math.max(i - 1, 0)] ?? p;
      const len = Math.hypot(q[0] - o[0], q[1] - o[1]) || 1;
      const w = (w0 + (w1 - w0) * (i / 18)) * 0.45;
      return f([p[0] - ((q[1] - o[1]) / len) * w, p[1] + ((q[0] - o[0]) / len) * w]);
    })
    .join(" L")}`;
  // Fine rootlets along the way, the way real roots feather out.
  const hairs: string[] = [];
  for (const t of [0.35, 0.6, 0.85]) {
    if (r() < 0.35) continue;
    const [x, y] = at(t);
    const ang = Math.PI / 2 + (r() - 0.5) * 2.4;
    const len = 14 + r() * 22;
    hairs.push(
      `M${f([x, y])} Q${f([x + Math.cos(ang) * len * 0.6 + (r() - 0.5) * 8, y + Math.sin(ang) * len * 0.5])} ${f([x + Math.cos(ang) * len, y + Math.sin(ang) * len])}`,
    );
  }
  return { body, core, hairs, lit };
}

const STATUS_LABEL: Record<Status, string> = {
  goal: "goal",
  holds: "holds with these values",
  broken: "fails with these values",
  affected: "a premise broke",
  stale: "stale - recheck",
  at_risk: "at risk - argued",
  argued: "argued, not computed",
  bedrock: "bedrock",
  proposed: "proposed",
  unverified: "unverified - a premise is unconfirmed",
  partial: "passes - backing incomplete",
};
export const statusLabel = (s: Status) => STATUS_LABEL[s];

export function mountTreeView(host: HTMLElement, onSelect: (id: string) => void): TreeView {
  const stage = svg("g", { class: "stage" });
  const roots = svg("g", { class: "roots" });
  const marks = svg("g", { class: "marks" });
  const crown = svg("image", {
    href: "crown.webp",
    x: -CROWN_W / 2,
    y: -CROWN_H - 30,
    width: CROWN_W,
    height: CROWN_H,
    class: "crown",
  });
  const ground = svg("ellipse", { cx: 0, cy: -18, rx: 520, ry: 26, class: "ground" });
  const trunk = svg("path", {
    d: "M-34,-110 C-26,-60 -40,-30 -60,-14 L60,-14 C40,-30 26,-60 34,-110 Z",
    class: "trunk",
  });
  // Shared shading for the orbs: one light from the upper left.
  const defs = svg(
    "defs",
    {},
    svg(
      "radialGradient",
      { id: "orb-light", cx: "35%", cy: "30%", r: "60%" },
      svg("stop", { offset: "0%", "stop-color": "#fff", "stop-opacity": "0.85" }),
      svg("stop", { offset: "45%", "stop-color": "#fff", "stop-opacity": "0.12" }),
      svg("stop", { offset: "100%", "stop-color": "#fff", "stop-opacity": "0" }),
    ),
    svg(
      "radialGradient",
      { id: "orb-shade", cx: "65%", cy: "75%", r: "70%" },
      svg("stop", { offset: "40%", "stop-color": "#000", "stop-opacity": "0" }),
      svg("stop", { offset: "100%", "stop-color": "#000", "stop-opacity": "0.6" }),
    ),
    svg(
      "filter",
      { id: "root-shadow", x: "-20%", y: "-20%", width: "140%", height: "140%" },
      svg("feDropShadow", {
        dx: "3",
        dy: "5",
        stdDeviation: "3",
        "flood-color": "#000",
        "flood-opacity": "0.55",
      }),
    ),
  );
  const seed = svg(
    "g",
    { class: "seed", hidden: true },
    svg("circle", { r: 40, class: "ring r1" }),
    svg("circle", { r: 40, class: "ring r2" }),
    svg("circle", { r: 40, class: "ring r3" }),
    svg("ellipse", { rx: 13, ry: 9, class: "kernel" }),
  );
  stage.append(defs, ground, crown, trunk, roots, marks, seed);
  const canvas = svg("svg", { class: "canvas", "aria-label": "Idea tree" }, stage);
  host.append(canvas);

  let view = { x: 0, y: 0, k: 0.8 };
  let target = { ...view };
  // Until a person pans or zooms, the camera keeps the whole tree in frame.
  let autoFit = true;
  const seen = new Set<string>();
  let selected: string | undefined;
  let working: string | undefined;
  let goals = new Map<string, Pos>();
  // Drawn positions glide toward the layout, so a reflow never jumps.
  const drawn = new Map<string, Pos>();
  const groups = new Map<string, SVGGElement>();
  const paths = new Map<string, { el: SVGGElement; parent: string }>();
  let links: { el: SVGPathElement; a: string; b: string }[] = [];
  let parentOf = new Map<string, string | null>();

  // Names stay readable: the goal, the selected root and its neighbours carry
  // labels; the rest show theirs on hover.
  const labels = () => {
    // The main branches always carry their names.
    const near = new Set<string>(["goal"]);
    for (const [id, par] of parentOf) if (par === "goal") near.add(id);
    if (selected) {
      near.add(selected);
      const up = parentOf.get(selected);
      if (up) near.add(up);
      for (const [id, par] of parentOf) if (par === selected) near.add(id);
    }
    for (const [id, g] of groups)
      g.classList.toggle("labeled", near.has(id) || id.startsWith("ghost:"));
  };

  const ease = (a: number, b: number, f: number) => (Math.abs(b - a) < 0.05 ? b : a + (b - a) * f);

  const fit = () => {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || goals.size === 0) return;
    const xs = [...goals.values()].map((p) => p.x);
    const ys = [...goals.values()].map((p) => p.y);
    // Frame the roots; the crown may run past the column's sides.
    const minX = Math.min(...xs, -180) - 80;
    const maxX = Math.max(...xs, 180) + 80;
    const minY = -CROWN_H * 0.5;
    const maxY = Math.max(...ys) + 80;
    const k = Math.min(1.2, (r.width - 20) / (maxX - minX), (r.height - 40) / (maxY - minY));
    // The stage origin sits at 42% of the height; aim the box centre at the screen centre.
    target = {
      x: -((minX + maxX) / 2) * k,
      y: r.height / 2 + 30 - r.height * 0.42 - ((minY + maxY) / 2) * k,
      k,
    };
  };

  // The tree can never be dragged or zoomed out of sight: when it fits, it
  // stays whole on screen; when it is larger, it always covers the view.
  const fitAxis = (lo: number, hi: number, size: number) => {
    if (hi - lo > size * 0.9) {
      if (lo > size * 0.05) return size * 0.05 - lo;
      if (hi < size * 0.95) return size * 0.95 - hi;
      return 0;
    }
    if (lo < 0) return -lo;
    if (hi > size) return size - hi;
    return 0;
  };
  const clamp = () => {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || goals.size === 0) return;
    const xs = [...goals.values()].map((p) => p.x);
    const ys = [...goals.values()].map((p) => p.y);
    const k = target.k;
    const dx = fitAxis(
      r.width / 2 + target.x + (Math.min(...xs) - 90) * k,
      r.width / 2 + target.x + (Math.max(...xs) + 90) * k,
      r.width,
    );
    const dy = fitAxis(
      r.height * 0.42 + target.y + -CROWN_H * 0.5 * k,
      r.height * 0.42 + target.y + (Math.max(...ys) + 70) * k,
      r.height,
    );
    if (dx || dy) target = { ...target, x: target.x + dx, y: target.y + dy };
  };

  const tick = () => {
    clamp();
    view = {
      x: ease(view.x, target.x, 0.12),
      y: ease(view.y, target.y, 0.12),
      k: ease(view.k, target.k, 0.12),
    };
    const r = canvas.getBoundingClientRect();
    stage.setAttribute(
      "transform",
      `translate(${String(r.width / 2 + view.x)} ${String(r.height * 0.42 + view.y)}) scale(${String(view.k)})`,
    );
    let moved = false;
    for (const [id, goal] of goals) {
      const cur = drawn.get(id);
      if (!cur) continue;
      const nx = ease(cur.x, goal.x, 0.16);
      const ny = ease(cur.y, goal.y, 0.16);
      if (nx === cur.x && ny === cur.y) continue;
      moved = true;
      cur.x = nx;
      cur.y = ny;
      groups.get(id)?.setAttribute("transform", `translate(${String(nx)} ${String(ny)})`);
    }
    if (moved) {
      for (const [id, { el: g, parent }] of paths) shapeRoot(g, id, parent);
      for (const l of links) l.el.setAttribute("d", linkPath(l.a, l.b));
    }
    if (alive) frame = requestAnimationFrame(tick);
  };
  let alive = true;
  let frame = requestAnimationFrame(tick);

  // Thick near the trunk, thin toward the tips.
  const shapeRoot = (g: SVGGElement, id: string, parent: string) => {
    const p = drawn.get(id);
    const q = drawn.get(parent);
    if (!p || !q) return;
    const depth = Math.max(0, Math.round(q.y / DY));
    const w0 = Math.max(1.4, 10 - depth * 3);
    const s = rootShape(q.x, q.y + (parent === "goal" ? 0 : 8), p.x, p.y - 8, id, w0, w0 * 0.42);
    const [body, lit, core, hairs] = [...g.children];
    body?.setAttribute("d", s.body);
    lit?.setAttribute("d", s.lit);
    core?.setAttribute("d", s.core);
    hairs?.setAttribute("d", s.hairs.join(" "));
  };

  const linkPath = (a: string, b: string) => {
    const p = drawn.get(a) ?? { x: 0, y: 0 };
    const q = drawn.get(b) ?? { x: 0, y: 0 };
    return `M${String(p.x)},${String(p.y)} Q${String((p.x + q.x) / 2)},${String(Math.max(p.y, q.y) + 80)} ${String(q.x)},${String(q.y)}`;
  };

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      autoFit = false;
      const k = Math.min(2.2, Math.max(0.3, target.k * Math.exp(-e.deltaY * 0.0012)));
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left - r.width / 2;
      const my = e.clientY - r.top - r.height * 0.42;
      target = {
        x: mx - ((mx - target.x) * k) / target.k,
        y: my - ((my - target.y) * k) / target.k,
        k,
      };
    },
    { passive: false },
  );
  let drag: { x: number; y: number } | undefined;
  canvas.addEventListener("pointerdown", (e) => {
    if ((e.target as Element).closest(".node")) return;
    autoFit = false;
    drag = { x: e.clientX - target.x, y: e.clientY - target.y };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    // Panning follows the pointer directly; easing here feels like lag.
    target = { ...target, x: e.clientX - drag.x, y: e.clientY - drag.y };
    view = { ...target };
  });
  canvas.addEventListener("pointerup", () => {
    drag = undefined;
  });
  canvas.addEventListener("dblclick", () => {
    autoFit = true;
    fit();
  });
  const onResize = () => {
    if (autoFit) fit();
  };
  window.addEventListener("resize", onResize);
  // While Muse works on the first roots, a seed germinates where they will grow.
  const seedNote = el("div", { class: "seed-note", hidden: true });
  host.append(seedNote);

  const chip = (n: IdeaNode | Ghost, status: Status | "ghost", id: string) => {
    const box = el(
      "div",
      { class: `chip ${status}` },
      el("span", { class: "dot" }),
      el("span", { class: "title" }, n.title),
    );
    if ("criticality" in n && n.criticality === "critical" && n.role !== "goal")
      box.classList.add("critical");
    const fo = svg("foreignObject", { x: -110, y: 14, width: 220, height: 64 });
    fo.append(box);
    const g = svg(
      "g",
      { class: `node ${status}`, "data-id": id, tabindex: 0, role: "button" },
      svg("circle", { r: 18, class: "halo" }),
      svg("circle", { r: 8, class: "orb" }),
      svg("circle", { r: 8, fill: "url(#orb-shade)", class: "shade" }),
      svg("circle", { r: 8, fill: "url(#orb-light)", class: "shine" }),
      fo,
    );
    g.addEventListener("click", () => {
      onSelect(id);
    });
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter") onSelect(id);
    });
    return g;
  };

  return {
    render(tree, ghosts = []) {
      goals = place(tree, ghosts);
      roots.replaceChildren();
      marks.replaceChildren();
      groups.clear();
      paths.clear();
      const fresh: SVGGElement[] = [];
      const all = [
        ...[...tree.nodes.values()].map((n) => ({
          id: n.id,
          parent: n.parent,
          node: n,
          status: tree.status(n.id),
        })),
        ...ghosts.map((g) => ({
          id: `ghost:${g.key}`,
          parent: g.under,
          node: g,
          status: "ghost" as const,
        })),
      ];
      // A real node takes over where its ghost was drawn.
      for (const g of ghosts) drawn.delete(`ghost:${g.key}`);
      for (const { id, parent } of all) {
        if (drawn.has(id)) continue;
        // New roots start at their parent and slide out.
        const from = drawn.get(parent ?? "") ?? goals.get(id) ?? { x: 0, y: 0 };
        drawn.set(id, { ...from });
      }
      for (const id of [...drawn.keys()]) if (!goals.has(id)) drawn.delete(id);
      for (const { id, parent, node, status } of all) {
        const p = drawn.get(id);
        if (!p) continue;
        if (parent) {
          const path = svg(
            "g",
            { class: `root ${status}` },
            svg("path", { class: "body" }),
            svg("path", { class: "lit" }),
            svg("path", { class: "core" }),
            svg("path", { class: "hairs" }),
          );
          shapeRoot(path, id, parent);
          roots.append(path);
          paths.set(id, { el: path, parent });
          if (!seen.has(id)) fresh.push(path);
        }
        const g = chip(node, status, id);
        g.setAttribute("transform", `translate(${String(p.x)} ${String(p.y)})`);
        if (!seen.has(id)) g.classList.add("sprout");
        if (id === selected) g.classList.add("selected");
        if (id === working) g.classList.add("working");
        marks.append(g);
        groups.set(id, g);
      }
      links = [];
      for (const n of tree.nodes.values()) {
        for (const b of n.basis) {
          if (!drawn.has(n.id) || !drawn.has(b)) continue;
          const path = svg("path", { d: linkPath(n.id, b), class: "link" });
          roots.append(path);
          links.push({ el: path, a: n.id, b });
        }
      }
      for (const path of fresh) {
        path.classList.add("growing");
        requestAnimationFrame(() => {
          path.classList.remove("growing");
        });
      }
      for (const { id } of all) if (!id.startsWith("ghost:")) seen.add(id);
      parentOf = new Map(all.map((a) => [a.id, a.parent]));
      labels();
      if (autoFit) fit();
    },
    mark(ids) {
      const lit = new Set(ids);
      for (const g of marks.querySelectorAll(".node"))
        g.classList.toggle("lit", lit.has(g.getAttribute("data-id") ?? ""));
    },
    select(id) {
      selected = id;
      for (const g of marks.querySelectorAll(".node"))
        g.classList.toggle("selected", g.getAttribute("data-id") === id);
      labels();
    },
    focus(id) {
      const p = goals.get(id);
      if (!p) return;
      // Only move when the node is out of view, and keep the zoom.
      const r = canvas.getBoundingClientRect();
      const sx = r.width / 2 + target.x + p.x * target.k;
      const sy = r.height * 0.42 + target.y + p.y * target.k;
      if (sx > r.width * 0.1 && sx < r.width * 0.9 && sy > r.height * 0.1 && sy < r.height * 0.9)
        return;
      target = { ...target, x: -p.x * target.k, y: -p.y * target.k + 40 };
    },
    seed(text) {
      const on = text !== undefined;
      seed.toggleAttribute("hidden", !on);
      seedNote.hidden = !on;
      if (on) {
        seedNote.replaceChildren(el("b", {}, "Muse is working on the seed"), el("span", {}, text));
        if (autoFit) target = { x: 0, y: 40, k: 1.3 };
      } else if (autoFit) fit();
    },
    refit() {
      autoFit = true;
      fit();
    },
    dispose() {
      alive = false;
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    },
    busy(id) {
      working = id;
      for (const g of marks.querySelectorAll(".node"))
        g.classList.toggle("working", g.getAttribute("data-id") === id);
    },
  };
}
