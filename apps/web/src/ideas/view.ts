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
    href: "/crown.webp",
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

  let view = { x: 0, y: 0, k: 1 };
  let target = { ...view };
  const seen = new Set<string>();
  let selected: string | undefined;
  let working: string | undefined;
  let positions = new Map<string, Pos>();

  const apply = () => {
    const r = canvas.getBoundingClientRect();
    stage.setAttribute(
      "transform",
      `translate(${String(r.width / 2 + view.x)} ${String(r.height * 0.42 + view.y)}) scale(${String(view.k)})`,
    );
  };
  // Eased camera, so focusing a node glides instead of jumping.
  const tick = () => {
    view = {
      x: view.x + (target.x - view.x) * 0.14,
      y: view.y + (target.y - view.y) * 0.14,
      k: view.k + (target.k - view.k) * 0.14,
    };
    apply();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const k = Math.min(2.2, Math.max(0.25, target.k * Math.exp(-e.deltaY * 0.0015)));
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
    drag = { x: e.clientX - target.x, y: e.clientY - target.y };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (drag) target = { ...target, x: e.clientX - drag.x, y: e.clientY - drag.y };
  });
  canvas.addEventListener("pointerup", () => {
    drag = undefined;
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
      positions = place(tree, ghosts);
      roots.replaceChildren();
      marks.replaceChildren();
      const fresh: SVGPathElement[] = [];
      const all: {
        id: string;
        parent: string | null;
        node: IdeaNode | Ghost;
        status: Status | "ghost";
      }[] = [
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
      for (const { id, parent, node, status } of all) {
        const p = positions.get(id);
        if (!p) continue;
        if (parent) {
          const q = positions.get(parent) ?? { x: 0, y: 0 };
          const d = rootPath(q.x, q.y + (parent === "goal" ? 0 : 10), p.x, p.y - 8, id);
          const path = svg("path", { d, class: `root ${status}` });
          roots.append(path);
          if (!seen.has(id)) fresh.push(path);
        }
        const g = chip(node, status, id);
        g.setAttribute("transform", `translate(${String(p.x)} ${String(p.y)})`);
        if (!seen.has(id)) g.classList.add("sprout");
        if (id === selected) g.classList.add("selected");
        if (id === working) g.classList.add("working");
        marks.append(g);
      }
      for (const n of tree.nodes.values()) {
        for (const b of n.basis) {
          const a = positions.get(n.id);
          const c = positions.get(b);
          if (a && c)
            roots.append(
              svg("path", {
                d: `M${String(a.x)},${String(a.y)} Q${String((a.x + c.x) / 2)},${String(Math.max(a.y, c.y) + 80)} ${String(c.x)},${String(c.y)}`,
                class: "link",
              }),
            );
        }
      }
      // A root grows from its parent: the stroke is drawn in over its length.
      for (const path of fresh) {
        const len = path.getTotalLength();
        path.style.strokeDasharray = String(len);
        path.style.strokeDashoffset = String(len);
        requestAnimationFrame(() => {
          path.style.transition = "stroke-dashoffset 1.1s cubic-bezier(.2,.7,.2,1)";
          path.style.strokeDashoffset = "0";
        });
      }
      for (const { id } of all) if (!id.startsWith("ghost:")) seen.add(id);
    },
    select(id) {
      selected = id;
      for (const g of marks.querySelectorAll(".node"))
        g.classList.toggle("selected", g.getAttribute("data-id") === id);
    },
    focus(id) {
      const p = positions.get(id);
      if (!p) return;
      const k = Math.max(target.k, 0.9);
      // Leave room for the side panel on wide screens.
      const shift = window.innerWidth > 900 ? 200 : 0;
      target = { x: -p.x * k - shift, y: -p.y * k + 60, k };
    },
    busy(id) {
      working = id;
      for (const g of marks.querySelectorAll(".node"))
        g.classList.toggle("working", g.getAttribute("data-id") === id);
    },
  };
}
