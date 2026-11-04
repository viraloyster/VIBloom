// The idea tree drawn as roots under a guanacaste crown. Each root grows in
// when its node is created; colours come only from the status the code derives.

import type { IdeaNode, IdeaTree, Status } from "@vibloom/ideas";
import { el, svg } from "../dom";
import { rootPath } from "../layout";

const DX = 230;
const DY = 190;
const CROWN_W = 760;
const CROWN_H = 400;

export interface Ghost {
  key: string;
  under: string;
  title: string;
}

export interface TreeView {
  render(tree: IdeaTree, ghosts?: Ghost[]): void;
  select(id: string | undefined): void;
  focus(id: string): void;
  busy(id: string | undefined): void;
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
  const walk = (id: string, depth: number): number => {
    const c = kids.get(id) ?? [];
    let x: number;
    if (c.length === 0) x = column++ * DX;
    else {
      const xs = c.map((k) => walk(k, depth + 1));
      x = ((xs[0] ?? 0) + (xs.at(-1) ?? 0)) / 2;
    }
    pos.set(id, { x, y: depth * DY });
    return x;
  };
  walk("goal", 0);
  const root = pos.get("goal")?.x ?? 0;
  for (const p of pos.values()) p.x -= root;
  return pos;
}

const STATUS_LABEL: Record<Status, string> = {
  goal: "goal",
  holds: "holds - computed",
  broken: "broken - computed",
  affected: "a premise broke",
  stale: "stale - recheck",
  at_risk: "at risk - argued",
  argued: "argued",
  bedrock: "bedrock",
  proposed: "proposed",
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
  stage.append(ground, crown, trunk, roots, marks);
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
  const paths = new Map<string, { el: SVGPathElement; parent: string }>();
  let links: { el: SVGPathElement; a: string; b: string }[] = [];

  const ease = (a: number, b: number, f: number) => (Math.abs(b - a) < 0.05 ? b : a + (b - a) * f);

  const fit = () => {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || goals.size === 0) return;
    const xs = [...goals.values()].map((p) => p.x);
    const ys = [...goals.values()].map((p) => p.y);
    const minX = Math.min(...xs, -CROWN_W / 2) - 130;
    const maxX = Math.max(...xs, CROWN_W / 2) + 130;
    const minY = -CROWN_H - 30;
    const maxY = Math.max(...ys) + 90;
    const k = Math.min(1.1, (r.width - 40) / (maxX - minX), (r.height - 110) / (maxY - minY));
    // The stage origin sits at 42% of the height; aim the box centre at the screen centre.
    target = {
      x: -((minX + maxX) / 2) * k,
      y: r.height / 2 + 30 - r.height * 0.42 - ((minY + maxY) / 2) * k,
      k,
    };
  };

  const tick = () => {
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
      for (const [id, { el: path, parent }] of paths) {
        const p = drawn.get(id);
        const q = drawn.get(parent);
        if (p && q)
          path.setAttribute(
            "d",
            rootPath(q.x, q.y + (parent === "goal" ? 0 : 10), p.x, p.y - 8, id),
          );
      }
      for (const l of links) l.el.setAttribute("d", linkPath(l.a, l.b));
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

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
      const k = Math.min(2.2, Math.max(0.2, target.k * Math.exp(-e.deltaY * 0.0012)));
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
  window.addEventListener("resize", () => {
    if (autoFit) fit();
  });

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
      svg("circle", { r: 7, class: "orb" }),
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
      const fresh: SVGPathElement[] = [];
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
          const q = drawn.get(parent) ?? { x: 0, y: 0 };
          const path = svg("path", {
            d: rootPath(q.x, q.y + (parent === "goal" ? 0 : 10), p.x, p.y - 8, id),
            class: `root ${status}`,
          });
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
      if (autoFit) fit();
    },
    select(id) {
      selected = id;
      for (const g of marks.querySelectorAll(".node"))
        g.classList.toggle("selected", g.getAttribute("data-id") === id);
    },
    focus(id) {
      const p = goals.get(id);
      if (!p) return;
      autoFit = false;
      // Keep the zoom; only bring the node into view, beside the side panel.
      const shift = window.innerWidth > 900 ? 200 : 0;
      target = { ...target, x: -p.x * target.k - shift, y: -p.y * target.k + 40 };
    },
    busy(id) {
      working = id;
      for (const g of marks.querySelectorAll(".node"))
        g.classList.toggle("working", g.getAttribute("data-id") === id);
    },
  };
}
