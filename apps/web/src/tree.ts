// The guanacaste: the canopy shows how much has been built, the roots are the
// map. Every state drawn here is derived by the engine, never by the browser.
// Cyan only ever means selection; red, yellow and the rest are scientific state.

import type { RootNode } from "@vibloom/contracts";
import type { ProjectView } from "./api";
import { CROWN, rng } from "./canopy";
import { el, svg } from "./dom";
import { filaments, layout, rootSystem, TRUNK, type Layout } from "./layout";

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

export type Tone = "sprout" | "probe" | "surprise" | "insight";

export interface TreeHandle {
  render(view: ProjectView): void;
  pulse(ids: string[], tone: Tone): void;
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

// A broad, buttressed trunk, as guanacastes have; the crown sits on top.
function trunk(): SVGGElement {
  const x = TRUNK.x;
  const y = TRUNK.y;
  const bark = svg(
    "linearGradient",
    { id: "bark", x1: 0, y1: 0, x2: 1, y2: 0 },
    svg("stop", { offset: "0", "stop-color": "#140e0a" }),
    svg("stop", { offset: "0.45", "stop-color": "#3b2a1e" }),
    svg("stop", { offset: "1", "stop-color": "#0f0a07" }),
  );
  const body = svg("path", {
    d: `M${String(x - 92)},${String(y)} C${String(x - 48)},${String(y - 20)} ${String(x - 40)},${String(y - 70)} ${String(x - 34)},${String(y - 150)}
        L${String(x + 34)},${String(y - 150)} C${String(x + 40)},${String(y - 70)} ${String(x + 48)},${String(y - 20)} ${String(x + 92)},${String(y)} Z`,
    fill: "url(#bark)",
  });
  return svg("g", { class: "trunk", "pointer-events": "none" }, svg("defs", {}, bark), body);
}

// The crown fills out as claims gather evidence.
function crown(fullness: number): SVGImageElement {
  const scale = 0.84 + 0.16 * fullness;
  const img = svg("image", {
    href: "/crown.webp",
    x: (TRUNK.x - CROWN.width / 2).toFixed(1),
    y: (TRUNK.y - CROWN.height + 6).toFixed(1),
    width: CROWN.width,
    height: CROWN.height,
    class: "crown",
    preserveAspectRatio: "xMidYMax meet",
  });
  img.style.transform = `scale(${scale.toFixed(3)})`;
  return img;
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
    const inside = box.x >= 4 && box.x + w <= W - 4;
    if (inside && !taken.some((b) => overlaps(b, box))) {
      taken.push(box);
      return t;
    }
  }
  const fallback = { dx: x > W / 2 ? -18 - w : 18, dy: -12 };
  taken.push({ x: x + fallback.dx, y: y + fallback.dy, w, h: 24 });
  return fallback;
}

export function mountTree(host: HTMLElement): TreeHandle {
  const root = svg("svg", {
    viewBox: `0 0 ${String(W)} ${String(H)}`,
    class: "tree-svg",
    role: "img",
  });
  const detail = el("div", { class: "node-detail" });
  const zoomIn = el("button", { type: "button", title: "Zoom in", "aria-label": "Zoom in" }, "+");
  const zoomOut = el(
    "button",
    { type: "button", title: "Zoom out", "aria-label": "Zoom out" },
    "-",
  );
  const fit = el("button", { type: "button", title: "Show the whole tree" }, "Fit");
  const stage = el(
    "div",
    { class: "stage" },
    root,
    el("div", { class: "zoom" }, zoomIn, zoomOut, fit),
  );
  host.replaceChildren(stage, detail);
  let selected: string | undefined;
  let listener: (id: string | undefined) => void = () => undefined;
  let last: ProjectView | undefined;
  let seen = new Set<string>();
  let strands: { height: number; group: SVGGElement } | undefined;
  let lay: Layout | undefined;

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
  // Smooth camera moves, so the eye can follow where the map goes.
  let flight = 0;
  function flyTo(target: { x: number; y: number; w: number }) {
    const from = { ...box };
    const to = { x: target.x, y: target.y, w: target.w, h: (target.w / W) * H };
    const start = performance.now();
    const id = ++flight;
    const step = (now: number) => {
      if (id !== flight) return;
      const t = Math.min(1, (now - start) / 650);
      const e = 1 - Math.pow(1 - t, 3);
      box = {
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        w: from.w + (to.w - from.w) * e,
        h: from.h + (to.h - from.h) * e,
      };
      apply();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  const zoomAt = (k: number, cx = box.x + box.w / 2, cy = box.y + box.h / 2) => {
    const w = Math.min(W * 1.6, Math.max(W / 6, box.w * k));
    const h = (w / W) * H;
    flyTo({ x: cx - ((cx - box.x) / box.w) * w, y: cy - ((cy - box.y) / box.h) * h, w });
  };
  zoomIn.addEventListener("click", () => {
    zoomAt(1 / 1.6);
  });
  zoomOut.addEventListener("click", () => {
    zoomAt(1.6);
  });
  fit.addEventListener("click", () => {
    flyTo({ x: 0, y: 0, w: W });
  });
  root.addEventListener("dblclick", (e) => {
    const r = root.getBoundingClientRect();
    zoomAt(
      1 / 2,
      box.x + ((e.clientX - r.left) / r.width) * box.w,
      box.y + ((e.clientY - r.top) / r.height) * box.h,
    );
  });

  let drag: { x: number; y: number } | undefined;
  let dragged = 0;
  root.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY };
    dragged = 0;
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
    dragged += Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y);
    drag = { x: e.clientX, y: e.clientY };
    apply();
  });

  // Everything the selected root rests on (down) and everything resting on
  // it (up), through every real dependency, not only the drawn tree.
  function reach(v: ProjectView, id: string | undefined) {
    const walk = (dir: "down" | "up") => {
      const out = new Set<string>();
      const stack = id ? [id] : [];
      for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
        for (const e of v.edges) {
          const [a, b] = dir === "down" ? [e.from, e.to] : [e.to, e.from];
          if (a === cur && !out.has(b)) {
            out.add(b);
            stack.push(b);
          }
        }
      }
      return out;
    };
    return { down: walk("down"), up: walk("up") };
  }

  function render(v: ProjectView) {
    last = v;
    lay = layout(v.nodes, v.edges);
    const claims = v.claims.filter((c) => c !== undefined);
    const withEvidence = claims.filter((c) => c.verdict.verdict !== "unexplored").length;
    const fullness = claims.length === 0 ? 0 : withEvidence / claims.length;
    // The ornamental root system is drawn once per soil depth and reused.
    if (strands?.height !== H) {
      const group = svg("g", { class: "strands", "pointer-events": "none" });
      for (const s of rootSystem(H - TRUNK.y - 60)) {
        group.append(
          svg("path", {
            d: s.d,
            "stroke-width": s.width.toFixed(2),
            class: `strand g${String(s.gen)}`,
          }),
        );
      }
      strands = { height: H, group };
    }
    const { down, up } = reach(v, selected);
    const inFocus = (id: string) => id === selected || down.has(id) || up.has(id);
    root.classList.toggle("focusing", selected !== undefined);
    const byId = new Map(v.nodes.map((n) => [n.id, n]));

    const decor = svg("g", { class: "filaments", "pointer-events": "none" });
    const roots = svg("g", { class: "roots" });
    const nodes = svg("g", { class: "nodes" });

    // Labels must not cover any root's node either.
    // A drawn root links a node to its parent: lit toward what the selection
    // rests on, or toward what rests on the selection.
    const litClass = (id: string, parent: string | undefined): string => {
      if (!selected || !inFocus(id)) return "";
      if (parent && !inFocus(parent)) return "";
      if (!parent && !(up.has(id) || id === selected)) return "";
      return down.has(id) ? " lit down" : " lit up";
    };
    const taken: Box[] = [...lay.nodes.values()].map((p) => ({
      x: p.x - 14,
      y: p.y - 14,
      w: 28,
      h: 28,
    }));
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
        class: `root ${state}${litClass(p.id, p.parent)}${fresh ? " sprout" : ""}`,
        "stroke-width": Math.max(1.4, 5 - p.depth * 1.1).toFixed(1),
      });
      roots.append(path);

      const g = svg("g", {
        "data-id": n.id,
        class: `node ${n.kind} ${state}${selected && inFocus(n.id) ? " in-focus" : ""}${selected === n.id ? " selected" : ""}${fresh ? " fresh" : ""}`,
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
        class: `label${(selected ? inFocus(n.id) : p.depth <= 1 || state === "broken" || state === "fragile") ? " always" : ""}`,
        transform: `translate(${spot.dx.toFixed(0)} ${spot.dy.toFixed(0)})`,
      });
      const t = svg("text", { x: 10, y: 16 });
      t.textContent = text;
      label.append(svg("rect", { width: width.toFixed(0), height: 24, rx: 8 }), t);
      g.append(label);
      const pick = () => {
        select(selected === n.id ? undefined : n.id);
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
          class: `link ${l.state}${inFocus(l.from) && inFocus(l.to) ? (down.has(l.to) ? " lit down" : " lit up") : ""}`,
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
      trunk(),
      crown(fullness),
      ground(),
      strands.group,
      decor,
      roots,
      nodes,
    );

    // New roots grow out from where they attach; nothing else re-animates.
    for (const path of root.querySelectorAll<SVGPathElement>("path.sprout")) {
      const len = path.getTotalLength();
      path.style.strokeDasharray = len.toFixed(1);
      path.style.strokeDashoffset = len.toFixed(1);
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
    // Direct links as buttons, so the map can be walked root by root.
    const hop = (ids: string[]) =>
      ids.length === 0
        ? el("span", { class: "hint" }, "nothing")
        : el(
            "span",
            { class: "hops" },
            ...ids.map((id) => {
              const target = v.nodes.find((x) => x.id === id);
              const b = el("button", { type: "button", class: "hop" }, target?.title ?? id);
              b.addEventListener("click", () => {
                select(id);
              });
              return b;
            }),
          );
    const restsOn = v.edges.filter((e) => e.from === n.id).map((e) => e.to);
    const dependents = v.edges.filter((e) => e.to === n.id).map((e) => e.from);
    detail.replaceChildren(
      el("h3", {}, n.title),
      el("dl", {}, ...rows.flatMap(([k, val]) => [el("dt", {}, k), el("dd", {}, val)])),
      el("p", { class: "hop-title down" }, "Rests on"),
      hop(restsOn),
      el("p", { class: "hop-title up" }, "Rests on it"),
      hop(dependents),
    );
  }

  // Selecting frames the root with everything it connects to.
  function select(id: string | undefined) {
    selected = id;
    listener(selected);
    if (!last) return;
    render(last);
    if (!id || !lay) {
      flyTo({ x: 0, y: 0, w: W });
      return;
    }
    const { down, up } = reach(last, id);
    const pts = [id, ...down, ...up].flatMap((k) => {
      const p = lay?.nodes.get(k);
      return p ? [p] : [];
    });
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const x0 = Math.min(...xs) - 160;
    const x1 = Math.max(...xs) + 160;
    const y0 = Math.min(...ys) - 140;
    const y1 = Math.max(...ys) + 160;
    const w = Math.min(W * 1.2, Math.max(420, x1 - x0, ((y1 - y0) * W) / H));
    flyTo({ x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - ((w / W) * H) / 2, w });
  }

  root.addEventListener("click", () => {
    if (dragged < 6 && selected) select(undefined);
  });

  // A glow that travels from the trunk along the roots to each target, then
  // makes it flash. Driven by the investigator's moves, never by the model
  // drawing anything itself.
  function pulse(ids: string[], tone: Tone) {
    if (!lay || !last) return;
    const layer = svg("g", { class: `pulses ${tone}`, "pointer-events": "none" });
    root.append(layer);
    ids.forEach((id, i) => {
      const chain: string[] = [];
      for (let cur: string | undefined = id; cur; cur = lay?.nodes.get(cur)?.parent) {
        chain.unshift(lay?.paths.get(cur) ?? "");
      }
      if (chain.length === 0 || !chain[0]) return;
      const d = chain.join(" ");
      const dot = svg("circle", { r: 6, class: "spark" });
      const motion = svg("animateMotion", {
        dur: "1.4s",
        begin: "indefinite",
        fill: "freeze",
        path: d,
        calcMode: "spline",
        keyTimes: "0;1",
        keySplines: ".3 0 .2 1",
      });
      dot.append(motion);
      layer.append(svg("path", { d, class: "trail" }), dot);
      // SVG animations count from page load; start each one explicitly.
      setTimeout(() => {
        motion.beginElement();
      }, i * 180);
      setTimeout(
        () => {
          root.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.add(`flash-${tone}`);
        },
        1400 + i * 180,
      );
    });
    setTimeout(
      () => {
        layer.remove();
        for (const n of root.querySelectorAll(`.flash-${tone}`))
          n.classList.remove(`flash-${tone}`);
      },
      3600 + ids.length * 180,
    );
  }

  return {
    render,
    pulse,
    onSelect(fn) {
      listener = fn;
    },
  };
}
