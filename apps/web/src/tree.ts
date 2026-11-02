// The guanacaste: the canopy shows how much has been built, the roots are the
// map. Every state drawn here is derived by the engine, never by the browser.

import type { RootNode } from "@vibloom/contracts";
import type { ProjectView } from "./api";
import { el, svg } from "./dom";

export type NodeState =
  "sound" | "hypothetical" | "fragile" | "broken" | "pending" | "open" | "off";

const ROWS: RootNode["kind"][][] = [
  ["claim", "lesson"],
  ["experiment"],
  ["model", "invariant"],
  ["assumption"],
  ["source"],
];

export function nodeState(v: ProjectView, n: RootNode): NodeState {
  switch (n.kind) {
    case "assumption": {
      if (n.state === "off") return "off";
      const blamed = v.lessons.some((l) => {
        if (l?.support.status !== "supported") return false;
        const lesson = v.nodes.find((x) => x.id === l.id);
        const candidate = l.support.candidate;
        return (
          lesson?.kind === "lesson" &&
          lesson.candidates.some((c) => c.id === candidate && c.suspects.includes(n.id))
        );
      });
      if (blamed) return "fragile";
      return n.state === "hypothetical" ? "hypothetical" : "sound";
    }
    case "claim": {
      const verdict = v.claims.find((c) => c?.claim === n.id)?.verdict.verdict;
      if (verdict === "refuted") return "broken";
      if (verdict === "holds" || verdict === "no_counterexample") return "sound";
      return verdict === "inconclusive" ? "fragile" : "open";
    }
    case "lesson": {
      const l = v.lessons.find((x) => x?.id === n.id);
      if (!l || l.retired) return "off";
      if (l.currency === "unsupported") return "broken";
      if (l.currency === "pending_review") return "pending";
      if (l.support.status === "supported") return "sound";
      return l.support.status === "open" || l.support.status === "awaiting_test"
        ? "open"
        : "fragile";
    }
    case "experiment":
      return v.results.some((r) => r.record.experiment.id === n.id && r.record.violated)
        ? "broken"
        : "sound";
    default:
      return "sound";
  }
}

export interface TreeHandle {
  render(view: ProjectView): void;
  onSelect(fn: (id: string | undefined) => void): void;
}

const W = 1000;
const GROUND = 300;

function canopy(fullness: number): SVGGElement {
  const g = svg("g", { class: "canopy" });
  // A wide, flat dome, as guanacastes grow in open pasture.
  const clusters = 26 + Math.round(fullness * 34);
  for (let i = 0; i < clusters; i++) {
    const t = i / clusters;
    const angle = Math.PI * (0.06 + 0.88 * ((t * 7.31) % 1));
    const r = 0.55 + 0.45 * ((t * 3.7) % 1);
    const cx = W / 2 + Math.cos(angle) * 330 * r;
    const cy = 150 - Math.sin(angle) * 105 * r;
    g.append(
      svg("ellipse", {
        cx: cx.toFixed(1),
        cy: cy.toFixed(1),
        rx: (58 + 30 * ((t * 5.3) % 1)).toFixed(1),
        ry: (30 + 14 * ((t * 2.9) % 1)).toFixed(1),
        class: `leaf leaf-${String(i % 3)}`,
      }),
    );
  }
  return g;
}

function trunk(): SVGPathElement {
  return svg("path", {
    class: "trunk",
    d: `M ${String(W / 2 - 34)} ${String(GROUND)} C ${String(W / 2 - 22)} 230, ${String(W / 2 - 40)} 200, ${String(W / 2 - 90)} 160
        L ${String(W / 2 + 90)} 160 C ${String(W / 2 + 40)} 200, ${String(W / 2 + 22)} 230, ${String(W / 2 + 34)} ${String(GROUND)} Z`,
  });
}

export function mountTree(host: HTMLElement): TreeHandle {
  const root = svg("svg", { viewBox: `0 0 ${String(W)} 900`, class: "tree-svg", role: "img" });
  const detail = el("div", { class: "node-detail" });
  host.replaceChildren(el("h2", {}, "Roots"), root, detail);
  let selected: string | undefined;
  let listener: (id: string | undefined) => void = () => undefined;
  let last: ProjectView | undefined;

  // Zoom with the wheel, pan by dragging; the roots are the map.
  let box = { x: 0, y: 0, w: W, h: 900 };
  const apply = () => {
    root.setAttribute(
      "viewBox",
      `${String(box.x)} ${String(box.y)} ${String(box.w)} ${String(box.h)}`,
    );
  };
  root.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      const w = Math.min(W * 2, Math.max(W / 6, box.w * k));
      const h = (w / W) * 900;
      box = { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
      apply();
    },
    { passive: false },
  );
  let drag: { x: number; y: number } | undefined;
  root.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY };
  });
  root.addEventListener("pointerup", () => (drag = undefined));
  root.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const scale = box.w / root.clientWidth;
    box = {
      ...box,
      x: box.x - (e.clientX - drag.x) * scale,
      y: box.y - (e.clientY - drag.y) * scale,
    };
    drag = { x: e.clientX, y: e.clientY };
    apply();
  });

  function connected(v: ProjectView, id: string): Set<string> {
    const out = new Set([id]);
    for (const dir of ["down", "up"] as const) {
      const stack = [id];
      for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
        for (const e of v.edges) {
          const [a, b] = dir === "down" ? [e.from, e.to] : [e.to, e.from];
          if (a === cur && !out.has(b)) {
            out.add(b);
            stack.push(b);
          }
        }
      }
    }
    return out;
  }

  function render(v: ProjectView) {
    last = v;
    const pos = new Map<string, { x: number; y: number }>();
    ROWS.forEach((kinds, depth) => {
      const row = v.nodes.filter((n) => kinds.includes(n.kind));
      // Roots spread wider the deeper they go, out to the edge of the map.
      const spread = Math.min(390, 170 + depth * 80);
      row.forEach((n, i) => {
        const x =
          W / 2 +
          (row.length === 1
            ? (depth % 2 === 0 ? -1 : 1) * 60 * depth
            : -spread + (2 * spread * i) / (row.length - 1));
        pos.set(n.id, { x, y: GROUND + 90 + depth * 120 + (i % 2) * 26 });
      });
    });

    const claims = v.claims.filter((c) => c !== undefined);
    const withEvidence = claims.filter((c) => c.verdict.verdict !== "unexplored").length;
    const fullness = claims.length === 0 ? 0 : withEvidence / claims.length;
    const lit = selected ? connected(v, selected) : undefined;

    const edges = svg("g", { class: "edges" });
    for (const e of v.edges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) continue;
      const on = lit?.has(e.from) && lit.has(e.to);
      edges.append(
        svg("path", {
          d: `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} C ${a.x.toFixed(1)} ${((a.y + b.y) / 2).toFixed(1)}, ${b.x.toFixed(1)} ${((a.y + b.y) / 2).toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}`,
          class: `edge ${e.state}${on ? " lit" : ""}${lit && !on ? " dim" : ""}`,
        }),
      );
    }
    // Every root reaches the trunk: claims and lessons hang from it.
    for (const n of v.nodes) {
      if (n.kind !== "claim" && n.kind !== "lesson") continue;
      const p = pos.get(n.id);
      if (p) {
        edges.append(
          svg("path", {
            d: `M ${String(W / 2)} ${String(GROUND)} Q ${String(W / 2)} ${p.y.toFixed(1)}, ${p.x.toFixed(1)} ${p.y.toFixed(1)}`,
            class: "edge taproot",
          }),
        );
      }
    }

    const nodes = svg("g", { class: "nodes" });
    for (const n of v.nodes) {
      const p = pos.get(n.id);
      if (!p) continue;
      const state = nodeState(v, n);
      const g = svg("g", {
        class: `node ${n.kind} ${state}${selected === n.id ? " selected" : ""}${lit && !lit.has(n.id) ? " dim" : ""}`,
        transform: `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`,
        tabindex: 0,
        role: "button",
      });
      const label = svg("text", { y: 30, "text-anchor": "middle" });
      label.textContent = n.title.length > 28 ? `${n.title.slice(0, 27)}...` : n.title;
      g.append(svg("circle", { r: n.kind === "claim" || n.kind === "lesson" ? 14 : 10 }), label);
      const pick = () => {
        selected = selected === n.id ? undefined : n.id;
        listener(selected);
        render(v);
      };
      g.addEventListener("click", pick);
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter") pick();
      });
      nodes.append(g);
    }

    root.replaceChildren(
      canopy(fullness),
      trunk(),
      svg("line", { x1: -2000, x2: 3000, y1: GROUND, y2: GROUND, class: "ground" }),
      edges,
      nodes,
    );
    renderDetail(v);
  }

  function renderDetail(v: ProjectView) {
    const n = v.nodes.find((x) => x.id === selected);
    if (!n) {
      detail.replaceChildren(
        el("p", { class: "hint" }, "Select a root to see what it holds and what rests on it."),
      );
      return;
    }
    const rows: [string, string][] = [
      ["kind", n.kind],
      ["state", nodeState(v, n)],
      ["revision", String(n.revision)],
    ];
    if (n.kind === "assumption") rows.push(["statement", n.statement], ["scope", n.scope]);
    if (n.kind === "claim") rows.push(["text", n.text], ["version", String(n.version)]);
    if (n.kind === "lesson") {
      const l = v.lessons.find((x) => x?.id === n.id);
      rows.push(
        ["statement", n.statement],
        ["scope", n.scope],
        ["support", l?.support.status ?? "-"],
      );
      if (l?.support.status === "supported") rows.push(["backed cause", l.support.candidate]);
    }
    const dependents = v.edges.filter((e) => e.to === n.id).map((e) => e.from);
    rows.push(["rests on it", dependents.join(", ") || "-"]);
    detail.replaceChildren(
      el("h3", {}, n.title),
      el("dl", {}, ...rows.flatMap(([k, val]) => [el("dt", {}, k), el("dd", {}, val)])),
    );
  }

  return {
    render,
    onSelect(fn) {
      listener = fn;
      if (last) render(last);
    },
  };
}
