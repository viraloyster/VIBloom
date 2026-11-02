// The guanacaste: the canopy shows how much has been built, the roots are the
// map. Every state drawn here is derived by the engine, never by the browser.
// Cyan only ever means selection; red, yellow and the rest are scientific state.

import type { RootNode } from "@vibloom/contracts";
import type { ProjectView } from "./api";
import { CANOPY, paintCanopy, rng } from "./canopy";
import { el, svg } from "./dom";
import { filaments, layout, TRUNK, type Layout } from "./layout";

export type NodeState =
  "sound" | "hypothetical" | "fragile" | "broken" | "pending" | "open" | "off";

const STATE_LABEL: Record<NodeState, string> = {
  sound: "",
  hypothetical: "Hypothetical",
  fragile: "Weak",
  broken: "Broken",
  pending: "Pending review",
  open: "Open",
  off: "Off",
};

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
let H = 1500;

function defs(): SVGDefsElement {
  const glow = svg(
    "filter",
    { id: "glow", x: "-50%", y: "-50%", width: "200%", height: "200%" },
    svg("feGaussianBlur", { stdDeviation: 3.2, result: "b" }),
    svg(
      "feMerge",
      {},
      svg("feMergeNode", { in: "b" }),
      svg("feMergeNode", { in: "SourceGraphic" }),
    ),
  );
  const soft = svg(
    "filter",
    { id: "soft", x: "-50%", y: "-50%", width: "200%", height: "200%" },
    svg("feGaussianBlur", { stdDeviation: 1.2 }),
  );
  const earth = svg(
    "linearGradient",
    { id: "earth", x1: 0, y1: 0, x2: 0, y2: 1 },
    svg("stop", { offset: "0", "stop-color": "#0d1410" }),
    svg("stop", { offset: "0.05", "stop-color": "#07080d" }),
    svg("stop", { offset: "1", "stop-color": "#03030a" }),
  );
  const halo = svg(
    "radialGradient",
    { id: "halo" },
    svg("stop", { offset: "0", "stop-color": "rgb(150 110 255 / 55%)" }),
    svg("stop", { offset: "1", "stop-color": "rgb(150 110 255 / 0%)" }),
  );
  return svg("defs", {}, glow, soft, earth, halo);
}

function sky(): SVGGElement {
  const g = svg("g", { class: "sky", "pointer-events": "none" });
  const r = rng(11);
  for (let i = 0; i < 70; i++) {
    const x = r() * W;
    const y = r() * 230;
    g.append(
      svg("circle", {
        cx: x.toFixed(1),
        cy: y.toFixed(1),
        r: (0.4 + r() * 0.9).toFixed(2),
        opacity: (0.25 + r() * 0.5).toFixed(2),
      }),
    );
  }
  const title = svg("text", { x: W / 2, y: 70, "text-anchor": "middle", class: "brand" });
  title.textContent = "VIBloom";
  g.append(title);
  return g;
}

// A distant treeline on the horizon, behind the guanacaste.
function horizon(): SVGPathElement {
  const r = rng(17);
  let line = `M-40,${String(TRUNK.y)} `;
  for (let x = -40; x <= W + 40; x += 18) {
    line += `L${x.toFixed(0)},${(TRUNK.y - 28 - r() * 26).toFixed(1)} `;
  }
  return svg("path", { d: `${line}L${String(W + 40)},${String(TRUNK.y)} Z`, class: "treeline" });
}

function ground(): SVGGElement {
  const g = svg("g", { "pointer-events": "none" });
  g.append(
    svg("rect", { x: -3000, y: TRUNK.y, width: 7000, height: 4000, fill: "url(#earth)" }),
    svg("ellipse", { cx: TRUNK.x, cy: TRUNK.y + 8, rx: 160, ry: 26, fill: "url(#halo)" }),
  );
  // A strip of grass along the surface.
  const r = rng(5);
  let d = "";
  for (let x = -40; x < W + 40; x += 6) {
    const h = 4 + r() * 10;
    d += `M${x.toFixed(1)},${String(TRUNK.y)} l${((r() - 0.5) * 4).toFixed(1)},${(-h).toFixed(1)} `;
  }
  g.append(svg("path", { d, class: "grass" }));
  return g;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function placeLabel(taken: Box[], x: number, y: number, w: number): { dx: number; dy: number } {
  const tries = [
    { dx: 18, dy: -12 },
    { dx: -18 - w, dy: -12 },
    { dx: 18, dy: 14 },
    { dx: -18 - w, dy: 14 },
    { dx: -w / 2, dy: 20 },
  ];
  for (const t of tries) {
    const box = { x: x + t.dx, y: y + t.dy, w, h: 24 };
    if (!taken.some((b) => overlaps(b, box))) {
      taken.push(box);
      return t;
    }
  }
  const t = tries[0]!;
  taken.push({ x: x + t.dx, y: y + t.dy, w, h: 24 });
  return t;
}

export function mountTree(host: HTMLElement): TreeHandle {
  const root = svg("svg", {
    viewBox: `0 0 ${String(W)} ${String(H)}`,
    class: "tree-svg",
    role: "img",
  });
  const detail = el("div", { class: "node-detail" });
  host.replaceChildren(root, detail);
  let selected: string | undefined;
  let listener: (id: string | undefined) => void = () => undefined;
  let last: ProjectView | undefined;
  let seen = new Set<string>();
  let canopyFor = -1;
  let canopyHref = "";

  let box = { x: 0, y: 0, w: W, h: H };
  const apply = () => {
    root.setAttribute(
      "viewBox",
      `${box.x.toFixed(1)} ${box.y.toFixed(1)} ${box.w.toFixed(1)} ${box.h.toFixed(1)}`,
    );
    root.classList.toggle("near", box.w < 650);
  };
  root.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const k = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      const w = Math.min(W * 1.6, Math.max(W / 5, box.w * k));
      const h = (w / W) * H;
      const rect = root.getBoundingClientRect();
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top) / rect.height;
      box = { x: box.x + (box.w - w) * fx, y: box.y + (box.h - h) * fy, w, h };
      apply();
    },
    { passive: false },
  );
  let drag: { x: number; y: number } | undefined;
  root.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener("pointerup", () => (drag = undefined));
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

  // The path from the trunk to the focus, drawn in cyan.
  function focusLine(lay: Layout, id: string | undefined): Set<string> {
    const line = new Set<string>();
    for (let cur = id; cur; cur = lay.nodes.get(cur)?.parent) line.add(cur);
    return line;
  }

  function render(v: ProjectView) {
    last = v;
    const lay = layout(v.nodes, v.edges);
    const claims = v.claims.filter((c) => c !== undefined);
    const withEvidence = claims.filter((c) => c.verdict.verdict !== "unexplored").length;
    const fullness = claims.length === 0 ? 0 : withEvidence / claims.length;
    const step = Math.round(fullness * 10);
    if (step !== canopyFor) {
      canopyFor = step;
      canopyHref = paintCanopy(step / 10).toDataURL("image/png");
    }
    const focus = focusLine(lay, selected);
    const byId = new Map(v.nodes.map((n) => [n.id, n]));

    const decor = svg("g", { class: "filaments", "pointer-events": "none" });
    const roots = svg("g", { class: "roots" });
    const nodes = svg("g", { class: "nodes" });

    const taken: Box[] = [];
    for (const p of lay.nodes.values()) {
      const n = byId.get(p.id);
      if (!n) continue;
      const state = nodeState(v, n);
      // Terminal roots keep growing below their node, deeper than the map.
      const terminal = ![...lay.nodes.values()].some((c) => c.parent === p.id);
      for (const d of filaments(p.x, p.y, p.id, terminal ? 4 : 3, terminal ? 1.7 : 1.2)) {
        decor.append(svg("path", { d, class: `rootlet ${state}` }));
      }
      const fresh = !seen.has(p.id);
      const path = svg("path", {
        d: lay.paths.get(p.id) ?? "",
        class: `root ${state}${focus.has(p.id) ? " focus" : ""}${fresh ? " sprout" : ""}`,
        "stroke-width": Math.max(1.4, 5 - p.depth * 1.1).toFixed(1),
      });
      roots.append(path);

      const g = svg("g", {
        class: `node ${n.kind} ${state}${selected === n.id ? " selected" : ""}${fresh ? " fresh" : ""}`,
        transform: `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`,
        tabindex: 0,
        role: "button",
        "aria-label": `${n.title} ${STATE_LABEL[state]}`,
      });
      const big = n.kind === "claim" || n.kind === "lesson" || n.kind === "assumption";
      g.append(
        svg("circle", { r: big ? 11 : 8, class: "ring" }),
        svg("circle", { r: big ? 4.5 : 3.5, class: "core" }),
      );
      // Selection is an outline; the state colour stays.
      if (selected === n.id) g.append(svg("circle", { r: big ? 17 : 13, class: "select" }));
      const text = `${n.title.length > 30 ? `${n.title.slice(0, 29)}...` : n.title}${STATE_LABEL[state] ? `  ${STATE_LABEL[state]}` : ""}`;
      // Labels try the right, then the left, then lower, so neighbours never
      // cover each other.
      const width = text.length * 6.6 + 20;
      const spot = placeLabel(taken, p.x, p.y, width);
      const label = svg("g", {
        class: `label${p.depth <= 1 || state === "broken" || state === "fragile" || selected === n.id ? " always" : ""}`,
        transform: `translate(${spot.dx.toFixed(0)} ${spot.dy.toFixed(0)})`,
      });
      const t = svg("text", { x: 10, y: 16 });
      t.textContent = text;
      label.append(svg("rect", { width: width.toFixed(0), height: 24, rx: 8 }), t);
      g.append(label);
      const pick = () => {
        selected = selected === n.id ? undefined : n.id;
        listener(selected);
        render(v);
      };
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        pick();
      });
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter") pick();
      });
      nodes.append(g);
    }
    for (const b of lay.buds) {
      for (const d of filaments(b.x, b.y, b.id, 2, 0.8)) {
        decor.append(svg("path", { d, class: "rootlet" }));
      }
    }
    for (const l of lay.links) {
      roots.append(
        svg("path", {
          d: l.d,
          class: `link ${l.state}${focus.has(l.from) && focus.has(l.to) ? " focus" : ""}`,
        }),
      );
    }

    // The soil grows with the map so deep roots are never cut off.
    if (lay.height !== H) {
      H = Math.max(1500, lay.height);
      if (box.y === 0 && box.x === 0 && box.w === W) {
        box = { x: 0, y: 0, w: W, h: H };
        apply();
      }
    }
    root.replaceChildren(
      defs(),
      sky(),
      horizon(),
      svg("image", {
        href: canopyHref,
        x: 0,
        y: TRUNK.y - CANOPY.groundY,
        width: CANOPY.width,
        height: CANOPY.height,
        class: "crown",
      }),
      ground(),
      decor,
      roots,
      nodes,
    );

    // New roots grow out from where they attach; nothing else re-animates.
    for (const path of root.querySelectorAll<SVGPathElement>("path.sprout")) {
      const len = path.getTotalLength();
      path.style.strokeDasharray = `${len.toFixed(1)}`;
      path.style.strokeDashoffset = `${len.toFixed(1)}`;
      path.getBoundingClientRect();
      requestAnimationFrame(() => {
        path.style.transition = "stroke-dashoffset 1.6s cubic-bezier(.2,.7,.2,1)";
        path.style.strokeDashoffset = "0";
      });
    }
    seen = new Set(lay.nodes.keys());
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
      ["state", STATE_LABEL[nodeState(v, n)] || "Sound"],
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

  root.addEventListener("click", () => {
    if (selected && last) {
      selected = undefined;
      listener(undefined);
      render(last);
    }
  });

  return {
    render,
    onSelect(fn) {
      listener = fn;
    },
  };
}
