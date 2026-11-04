// The chemical clock as a recipe would run it: the period in seconds, a
// beaker coloured by the run's own oxidised catalyst at real speed (or a
// stated multiple of it), and the concentrations of both models over three
// periods. Everything is computed from the experiment's inputs.

import type { Trace } from "@vibloom/chem";
import type { CheckResult } from "@vibloom/ideas";
import { el, svg } from "../dom";
import { traces } from "./chem";

const RED = [184, 32, 42];
const BLUE = [35, 70, 184];
const W = 560;
const H = 150;

const colour = (f: number) =>
  `rgb(${RED.map((r, i) => Math.round(r + ((BLUE[i] ?? r) - r) * f)).join(" ")})`;

export function duration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "-";
  if (seconds < 90) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - 60 * m);
  return `${String(m)} min ${String(s).padStart(2, "0")} s`;
}

export function clockPanel(r: CheckResult): HTMLElement {
  const scale = r.inputs.time_scale_s;
  const seconds = (t: number) => (scale === undefined ? t : t * scale);
  const full = r.sim?.periods.full;
  const reduced = r.sim?.periods.reduced;
  const unit = scale === undefined ? "model time" : "seconds";
  const show = (p: number | undefined) =>
    p === undefined
      ? "-"
      : scale === undefined
        ? `${p.toFixed(2)} (model time)`
        : duration(p * scale);

  const liquid = svg("path", {
    d: "M22,58 L98,58 L104,150 Q104,160 94,160 L26,160 Q16,160 16,150 Z",
    class: "liquid",
  });
  const glass = svg("path", {
    d: "M14,20 L14,150 Q14,164 28,164 L92,164 Q106,164 106,150 L106,20 M8,20 L112,20",
    class: "glass",
  });
  const beaker = svg(
    "svg",
    { viewBox: "0 0 120 172", class: "beaker clock-beaker" },
    liquid,
    glass,
  );
  const elapsed = el("p", { class: "clock-time" }, "");
  const speeds = [1, 10, 60];
  // Real time for a fast clock; faster, and said so, for a slow one.
  let speed =
    full !== undefined && seconds(full) > 120
      ? 60
      : full !== undefined && seconds(full) > 20
        ? 10
        : 1;
  const buttons = speeds.map((k) => {
    const b = el(
      "button",
      { class: `ghost-btn speed${k === speed ? " on" : ""}` },
      `${String(k)}x`,
    );
    b.addEventListener("click", () => {
      speed = k;
      for (const x of buttons) x.classList.toggle("on", x === b);
    });
    return b;
  });

  const chart = svg("svg", { viewBox: `0 0 ${String(W)} ${String(H + 24)}`, class: "traces" });
  const cursor = svg("line", { x1: 0, x2: 0, y1: 0, y2: H, class: "cursor" });
  const status = el("p", { class: "fine" }, "Computing the concentrations of both models...");

  const panel = el(
    "div",
    { class: "clock" },
    el(
      "div",
      { class: "clock-head" },
      el(
        "div",
        {},
        el("p", { class: "eyebrow" }, scale === undefined ? "Period" : "Period of this recipe"),
        el("p", { class: "clock-period" }, show(full)),
        el(
          "p",
          { class: "fine" },
          reduced === undefined
            ? "full Oregonator model"
            : `full model; the two-variable model says ${show(reduced)}`,
        ),
      ),
      el("div", { class: "clock-live" }, beaker, elapsed, el("div", { class: "row" }, ...buttons)),
    ),
    chart,
    status,
    el(
      "p",
      { class: "fine" },
      scale === undefined
        ? "No recipe in this tree, so the period stays in the model's own time."
        : "Seconds come from the recipe through cited rate constants (Field, Scholarpedia 2007); the Oregonator is a semi-quantitative model, so a real beaker can differ.",
    ),
  );

  void traces(r).then(({ full: tf, reduced: tr }) => {
    if (!tf) {
      status.textContent = "The concentrations could not be computed for this run.";
      return;
    }
    status.textContent = `HBrO2 (log scale) over three periods, in ${unit}, both starting at a peak: full model solid, two-variable model dashed. The period is the time between consecutive HBrO2 peaks. The beaker shows the model's activity (its oxidised catalyst, normalised), not the physical colour of a solution.`;
    draw(chart, tf, tr, seconds);
    chart.append(cursor);
    animate(
      panel,
      tf,
      seconds,
      (t, z) => {
        liquid.setAttribute("fill", colour(z));
        const span = seconds(tf.t.at(-1) ?? 1);
        const x = (t / span) * W;
        cursor.setAttribute("x1", String(x));
        cursor.setAttribute("x2", String(x));
        elapsed.textContent = `${duration(t)} into the cycle, ${String(speed)}x`;
      },
      () => speed,
    );
  });
  return panel;
}

function draw(
  chart: SVGSVGElement,
  full: Trace,
  reduced: Trace | undefined,
  seconds: (t: number) => number,
) {
  const all = [...full.x, ...(reduced?.x ?? [])].filter((v) => v > 0);
  const lo = Math.log10(Math.min(...all));
  const hi = Math.log10(Math.max(...all));
  const span = seconds(full.t.at(-1) ?? 1);
  const path = (tr: Trace) =>
    tr.t
      .map((t, i) => {
        const x = (seconds(t) / span) * W;
        const y = H - ((Math.log10(Math.max(tr.x[i] ?? 0, 1e-300)) - lo) / (hi - lo)) * H;
        return `${i ? "L" : "M"}${x.toFixed(1)},${Math.min(H, Math.max(0, y)).toFixed(1)}`;
      })
      .join("");
  chart.append(svg("path", { d: path(full), class: "trace full" }));
  if (reduced) chart.append(svg("path", { d: path(reduced), class: "trace reduced" }));
  const label = (v: number) => (v < 120 ? v.toFixed(0) : `${(v / 60).toFixed(1)} min`);
  for (let k = 0; k <= 3; k++) {
    const x = (k / 3) * W;
    chart.append(
      svg(
        "text",
        { x: Math.min(W - 44, x + 2), y: H + 16, class: "tick" },
        document.createTextNode(label((span * k) / 3)),
      ),
    );
  }
}

// Plays the trace on a loop at the chosen speed while the panel is on screen.
function animate(
  panel: HTMLElement,
  tr: Trace,
  seconds: (t: number) => number,
  frame: (t: number, z: number) => void,
  speed: () => number,
) {
  const zs = tr.z;
  const zlo = Math.min(...zs);
  const zhi = Math.max(...zs);
  const span = seconds(tr.t.at(-1) ?? 1);
  let t = 0;
  let last = performance.now();
  let shown = false;
  const tick = (now: number) => {
    // Waits until the panel is placed; stops once it is taken away.
    if (!panel.isConnected) {
      if (!shown) requestAnimationFrame(tick);
      return;
    }
    shown = true;
    t = (t + ((now - last) / 1000) * speed()) % span;
    last = now;
    // Nearest sample: the trace is evenly spaced.
    const i = Math.min(zs.length - 1, Math.round((t / span) * (zs.length - 1)));
    frame(t, ((zs[i] ?? zlo) - zlo) / (zhi - zlo || 1));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
