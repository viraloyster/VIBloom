// The idea tree drawn as roots under a guanacaste crown. Each root grows in
// when its node is created; colours come only from the status the code derives.

import type { IdeaNode, IdeaTree, Status } from "@vibloom/ideas";
import { el, svg } from "../dom";
import { rng } from "../canopy";
import { hash } from "../layout";

const DX = 112;
const DY = 205;
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

// A faint web of rootlets under the whole tree, fixed by a seed: the soil is
// full of roots; the evidence is in the ones that carry a node.
function mesh(): string {
  const r = rng(7);
  const out: string[] = [];
  const f = (x: number, y: number) => `${x.toFixed(0)},${y.toFixed(0)}`;
  const fork = (x: number, y: number, ang: number, len: number, depth: number) => {
    const ex = x + Math.cos(ang) * len;
    const ey = y + Math.sin(ang) * len;
    out.push(
      `M${f(x, y)} Q${f(x + Math.cos(ang) * len * 0.5 + (r() - 0.5) * len * 0.4, y + Math.sin(ang) * len * 0.5)} ${f(ex, ey)}`,
    );
    if (depth === 0) return;
    for (let i = 0; i < 2 + Math.floor(r() * 2); i++) {
      const t = 0.5 + r() * 0.5;
      fork(x + (ex - x) * t, y + (ey - y) * t, ang + (r() - 0.5) * 1.1, len * 0.6, depth - 1);
    }
  };
  for (let i = 0; i < 14; i++) {
    const ang = Math.PI * (0.12 + 0.76 * (i / 13)) + (r() - 0.5) * 0.2;
    fork((r() - 0.5) * 40, -10, ang, 150 + r() * 120, 4);
  }
  return out.join(" ");
}

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
  // Rootlets that fork as they thin, along the root and in a fan at its tip.
  const hairs: string[] = [];
  const fork = (x: number, y: number, ang: number, len: number, depth: number) => {
    const ex = x + Math.cos(ang) * len;
    const ey = y + Math.sin(ang) * len;
    const mx = x + Math.cos(ang) * len * 0.5 + (r() - 0.5) * len * 0.3;
    const my = y + Math.sin(ang) * len * 0.5 + (r() - 0.5) * len * 0.3;
    hairs.push(`M${f([x, y])} Q${f([mx, my])} ${f([ex, ey])}`);
    if (depth === 0) return;
    const n = 2 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++) {
      const t = 0.45 + r() * 0.5;
      fork(
        x + (ex - x) * t,
        y + (ey - y) * t,
        ang + (r() - 0.5) * 1.3,
        len * (0.45 + r() * 0.2),
        depth - 1,
      );
    }
  };
  for (const t of [0.3, 0.5, 0.7, 0.88]) {
    if (r() < 0.3) continue;
    const [x, y] = at(t);
    const side = r() < 0.5 ? -1 : 1;
    fork(x, y, Math.PI / 2 + side * (0.5 + r() * 0.7), 18 + r() * 26, 2);
  }
  for (let i = 0; i < 4; i++) fork(bx, by, Math.PI / 2 + (r() - 0.5) * 1.8, 26 + r() * 30, 2);
  // Beads along the root, as in a circuit of evidence.
  const beads = [0.32, 0.62].map((t) => at(t));
  return { body, core, hairs, lit, beads };
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
  const ground = svg("ellipse", { cx: 0, cy: -16, rx: 900, ry: 9, class: "ground" });
  const trunk = svg("path", {
    d: "M-24,-118 C-20,-70 -24,-40 -64,-14 L64,-14 C24,-40 20,-70 24,-118 Z",
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
  const web = svg("path", { d: mesh(), class: "mesh" });
  stage.append(defs, web, ground, crown, trunk, roots, marks, seed);
  const canvas = svg("svg", { class: "canvas", "aria-label": "Idea tree" }, stage);
  host.append(canvas);

  let view = { x: 0, y: 0, k: 0.8 };
  // Measured when the column changes size, not read on every frame.
  let box = { width: 0, height: 0 };
  const calm = matchMedia("(prefers-reduced-motion: reduce)");
  let target = { ...view };
  // Until a person pans or zooms, the camera keeps the whole tree in frame.
  let autoFit = true;
  const seen = new Set<string>();
  let selected: string | undefined;
  let working: string | undefined;
  let goals = new Map<string, Pos>();
  // A tall, narrow column lets the roots run deeper instead of leaving the
  // soil empty: depth is stretched to the column's shape.
  let placed = new Map<string, Pos>();
  const stretched = () => {
    const k = box.width ? Math.min(2.2, Math.max(1, (box.height / box.width) * 1.15)) : 1;
    return new Map([...placed].map(([id, p]) => [id, { x: p.x, y: p.y * k }]));
  };
  // Drawn positions glide toward the layout, so a reflow never jumps.
  const drawn = new Map<string, Pos>();
  const groups = new Map<string, SVGGElement>();
  const paths = new Map<string, { el: SVGGElement; parent: string }>();
  let links: { el: SVGPathElement; a: string; b: string }[] = [];
  let basisOf = new Map<string, string[]>();
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
    declutter();
  };

  // Two lines for a selected root, drawn apart. Its foundations: everything
  // its status rests on, its sub-roots and the roots it cites as basis, all
  // the way down. Its place: the roots above it, up to the goal.
  const chain = () => {
    const support = new Set<string>();
    const walk = (id: string) => {
      if (support.has(id)) return;
      support.add(id);
      for (const [c, par] of parentOf) if (par === id) walk(c);
      for (const b of basisOf.get(id) ?? []) walk(b);
    };
    if (selected) walk(selected);
    const place = new Set<string>();
    for (let id = parentOf.get(selected ?? "") ?? undefined; id; id = parentOf.get(id) ?? undefined)
      place.add(id);
    for (const [id, { el: g }] of paths) {
      g.classList.toggle("support", support.has(id));
      g.classList.toggle("path", place.has(id) || id === selected);
    }
    for (const [id, g] of groups) {
      g.classList.toggle("support", support.has(id) && id !== selected);
      g.classList.toggle("path", place.has(id));
    }
    for (const l of links) l.el.classList.toggle("support", support.has(l.a) && support.has(l.b));
  };

  // Names keep their size at any zoom, so when the tree is far away some
  // would cover others: the selected root and the goal keep theirs, then
  // the higher roots; a hidden name returns on hover or focus.
  const declutter = () => {
    const placed: DOMRect[] = [];
    const rank = (id: string) => (id === selected ? 0 : id === "goal" ? 1 : 2);
    const order = [...groups.entries()]
      .filter(([, g]) => g.classList.contains("labeled"))
      .sort(([a], [b]) => rank(a) - rank(b) || (goals.get(a)?.y ?? 0) - (goals.get(b)?.y ?? 0));
    for (const [, g] of order) {
      const r = g.querySelector(".chip")?.getBoundingClientRect();
      if (!r) continue;
      const hit = placed.some(
        (q) =>
          r.left < q.right + 2 &&
          q.left < r.right + 2 &&
          r.top < q.bottom + 2 &&
          q.top < r.bottom + 2,
      );
      g.classList.toggle("crowded", hit);
      if (!hit) placed.push(r);
    }
  };

  const ease = (a: number, b: number, f: number) => (Math.abs(b - a) < 0.05 ? b : a + (b - a) * f);

  const fit = () => {
    const r = box;
    if (r.width === 0 || goals.size === 0) return;
    const xs = [...goals.values()].map((p) => p.x);
    const ys = [...goals.values()].map((p) => p.y);
    // Frame the roots; the crown may run past the column's sides.
    const minX = Math.min(...xs, -180) - 80;
    const maxX = Math.max(...xs, 180) + 80;
    // The canopy may be cut at the top: the roots are the instrument.
    const minY = -CROWN_H * 0.32;
    const maxY = Math.max(...ys) + 130;
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
    const r = box;
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

  // Labels and hit areas keep their size on screen at any zoom.
  let labelK = 0;
  const scaleLabels = (force = false) => {
    if (!force && labelK === view.k) return;
    labelK = view.k;
    const t = `scale(${String(1 / view.k)})`;
    for (const g of groups.values()) g.querySelector(".fixed")?.setAttribute("transform", t);
  };

  // The loop sleeps once the camera and every root have arrived, and wakes
  // on any change; a still tree costs no frames.
  const tick = () => {
    frame = 0;
    clamp();
    const f = calm.matches ? 1 : 0.12;
    const prev = view;
    view = {
      x: ease(view.x, target.x, f),
      y: ease(view.y, target.y, f),
      k: Math.abs(target.k - view.k) < 0.002 ? target.k : view.k + (target.k - view.k) * f,
    };
    const r = box;
    stage.setAttribute(
      "transform",
      `translate(${String(r.width / 2 + view.x)} ${String(r.height * 0.42 + view.y)}) scale(${String(view.k)})`,
    );
    scaleLabels();
    let moved = false;
    for (const [id, goal] of goals) {
      const cur = drawn.get(id);
      if (!cur) continue;
      const nx = ease(cur.x, goal.x, calm.matches ? 1 : 0.16);
      const ny = ease(cur.y, goal.y, calm.matches ? 1 : 0.16);
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
    const still = !moved && prev.x === view.x && prev.y === view.y && prev.k === view.k;
    if (alive && !still) frame = requestAnimationFrame(tick);
    else declutter();
  };
  let alive = true;
  let frame = 0;
  const wake = () => {
    if (alive && !frame) frame = requestAnimationFrame(tick);
  };
  const sizer = new ResizeObserver(() => {
    const r = canvas.getBoundingClientRect();
    box = { width: r.width, height: r.height };
    goals = stretched();
    if (autoFit) fit();
    wake();
  });
  sizer.observe(canvas);

  // Thick near the trunk, thin toward the tips.
  const shapeRoot = (g: SVGGElement, id: string, parent: string) => {
    const p = drawn.get(id);
    const q = drawn.get(parent);
    if (!p || !q) return;
    const depth = Math.max(0, Math.round(q.y / DY));
    const w0 = Math.max(1.4, 10 - depth * 3);
    const s = rootShape(q.x, q.y + (parent === "goal" ? 0 : 8), p.x, p.y - 8, id, w0, w0 * 0.42);
    const [body, lit, core, hairs, b1, b2] = [...g.children];
    body?.setAttribute("d", s.body);
    lit?.setAttribute("d", s.lit);
    core?.setAttribute("d", s.core);
    hairs?.setAttribute("d", s.hairs.join(" "));
    for (const [i, b] of [b1, b2].entries()) {
      const p2 = s.beads[i];
      if (b && p2) {
        b.setAttribute("cx", String(p2[0]));
        b.setAttribute("cy", String(p2[1]));
      }
    }
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
      wake();
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
    wake();
  });
  canvas.addEventListener("pointerup", () => {
    drag = undefined;
  });
  canvas.addEventListener("dblclick", () => {
    autoFit = true;
    fit();
    wake();
  });
  // Camera controls: whole tree, closer, farther, the selected root.
  const zoom = (by: number) => {
    autoFit = false;
    const k = Math.min(2.2, Math.max(0.3, target.k * by));
    target = { x: (target.x * k) / target.k, y: (target.y * k) / target.k, k };
    wake();
  };
  const control = (label: string, title: string, act: () => void) => {
    const b = el("button", { class: "cam", title, "aria-label": title }, label);
    b.addEventListener("click", act);
    return b;
  };
  host.append(
    el(
      "div",
      { class: "camera" },
      control("Fit", "Show the whole tree", () => {
        autoFit = true;
        fit();
        wake();
      }),
      control("+", "Zoom in", () => {
        zoom(1.25);
      }),
      control("-", "Zoom out", () => {
        zoom(0.8);
      }),
      control("Focus", "Center the selected root", () => {
        const p = selected ? goals.get(selected) : undefined;
        if (!p) return;
        autoFit = false;
        target = { ...target, x: -p.x * target.k, y: -p.y * target.k + 40 };
        wake();
      }),
    ),
  );
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
      {
        class: `node ${status}`,
        "data-id": id,
        tabindex: 0,
        role: "button",
        "aria-label": n.title,
      },
      svg("circle", { r: 18, class: "halo" }),
      svg("circle", { r: 8, class: "orb" }),
      svg("circle", { r: 8, fill: "url(#orb-shade)", class: "shade" }),
      svg("circle", { r: 8, fill: "url(#orb-light)", class: "shine" }),
      // Counter-scaled with the zoom: a 36 px target and a readable name.
      svg(
        "g",
        { class: "fixed", transform: `scale(${String(1 / view.k)})` },
        svg("circle", { r: 18, class: "hit" }),
        fo,
      ),
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
      placed = place(tree, ghosts);
      goals = stretched();
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
            svg("circle", { r: 2.6, class: "bead" }),
            svg("circle", { r: 2.6, class: "bead" }),
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
      basisOf = new Map([...tree.nodes.values()].map((n) => [n.id, n.basis]));
      chain();
      labels();
      if (autoFit) fit();
      scaleLabels(true);
      wake();
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
      chain();
      labels();
    },
    focus(id) {
      const p = goals.get(id);
      if (!p) return;
      // Only move when the node is out of view, and keep the zoom.
      const r = box;
      const sx = r.width / 2 + target.x + p.x * target.k;
      const sy = r.height * 0.42 + target.y + p.y * target.k;
      if (sx > r.width * 0.1 && sx < r.width * 0.9 && sy > r.height * 0.1 && sy < r.height * 0.9)
        return;
      target = { ...target, x: -p.x * target.k, y: -p.y * target.k + 40 };
      wake();
    },
    seed(text) {
      const on = text !== undefined;
      seed.toggleAttribute("hidden", !on);
      seedNote.hidden = !on;
      if (on) {
        seedNote.replaceChildren(el("b", {}, "Muse is working on the seed"), el("span", {}, text));
        if (autoFit) target = { x: 0, y: 40, k: 1.3 };
      } else if (autoFit) fit();
      wake();
    },
    refit() {
      autoFit = true;
      fit();
      wake();
    },
    dispose() {
      alive = false;
      cancelAnimationFrame(frame);
      sizer.disconnect();
    },
    busy(id) {
      working = id;
      for (const g of marks.querySelectorAll(".node"))
        g.classList.toggle("working", g.getAttribute("data-id") === id);
    },
  };
}
