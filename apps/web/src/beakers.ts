// Twin beakers: the full and the reduced model at the exact point of a recorded
// run, coloured by the oxidised catalyst z(t) that turns a real BZ solution
// from red to blue. Everything shown is computed here from the run's point,
// model parameters and initial condition; nothing is a stock animation.

import type { ClaimNode, ModelNode, ResultRecord } from "@vibloom/contracts";
import { catalystOffThread } from "./compute";
import { el, fmt, pct, svg } from "./dom";

const RED = [184, 32, 42];
const BLUE = [35, 70, 184];
// Skip the start so both beakers show their settled rhythm.
const TRANSIENT = 20;
const LOOP_SECONDS = 24;

function colour(f: number): string {
  const c = RED.map((r, i) => Math.round(r + ((BLUE[i] ?? r) - r) * f));
  return `rgb(${c.join(" ")})`;
}

function beaker(label: string, detail: string) {
  const liquid = svg("path", {
    d: "M22,58 L98,58 L104,150 Q104,160 94,160 L26,160 Q16,160 16,150 Z",
    class: "liquid",
  });
  const glass = svg("path", {
    d: "M14,20 L14,150 Q14,164 28,164 L92,164 Q106,164 106,150 L106,20 M8,20 L112,20",
    class: "glass",
  });
  const shine = svg("path", { d: "M26,66 L26,148", class: "shine" });
  const graphic = svg("svg", { viewBox: "0 0 120 172", class: "beaker" }, liquid, glass, shine);
  const box = el(
    "figure",
    { class: "beaker-box" },
    graphic,
    el("figcaption", {}, el("b", {}, label), el("span", {}, detail)),
  );
  return { box, liquid };
}

export function twinBeakers(
  r: ResultRecord,
  claim: ClaimNode,
  model: ModelNode,
  restsOn: string[],
): HTMLElement {
  const models = (r.measurements ?? [])
    .map((m) => m.model)
    .filter((m): m is "full" | "reduced" => m === "full" || m === "reduced");
  const host = el("div", { class: "beakers" });
  if (models.length === 0 || !r.point) return host;

  const period = (m: string) => r.measurements?.find((x) => x.model === m)?.period;
  const full = beaker(
    "Full model",
    `bromide y kept as a variable, period ${fmt(period("full"), 4)}`,
  );
  const reduced = beaker(
    "Reduced model",
    `eps_prime y' = 0, bromide eliminated, period ${fmt(period("reduced"), 4)}`,
  );
  const gap = el("p", { class: "phase" }, "Integrating both models in your browser...");
  host.append(
    el(
      "div",
      { class: "pair" },
      ...(models.includes("full") ? [full.box] : []),
      ...(models.includes("reduced") ? [reduced.box] : []),
    ),
    gap,
    el(
      "p",
      { class: "provenance" },
      `Computed now from run ${r.id}: point ${JSON.stringify(r.point)}, initial condition ${r.ic ?? claim.predicate.ic}, model ${model.id} rev ${String(model.revision)}. Rests on: ${restsOn.join(", ") || "-"}. Recorded period error ${pct(r.comparison?.relativeError)}.`,
    ),
  );

  void catalystOffThread(models, claim, model, r.point).then((series) => {
    if (!host.isConnected) return;
    const tracks = series.map((s) => {
      const start = s.t.findIndex((t) => t >= TRANSIENT);
      const z = s.z.slice(start);
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of z) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      return { name: s.name, z, lo, hi, dt: (s.t[1] ?? 0) - (s.t[0] ?? 0) };
    });
    const span = Math.min(...tracks.map((t) => t.z.length));
    const tauPerSecond = (span * (tracks[0]?.dt ?? 0.05)) / LOOP_SECONDS;
    const tf = period("full");
    const tr = period("reduced");
    const t0 = performance.now();

    const frame = (now: number) => {
      if (!host.isConnected) return;
      const elapsed = ((now - t0) / 1000) % LOOP_SECONDS;
      const tau = elapsed * tauPerSecond;
      for (const t of tracks) {
        const i = Math.min(t.z.length - 1, Math.floor(tau / t.dt));
        const f = t.hi > t.lo ? ((t.z[i] ?? t.lo) - t.lo) / (t.hi - t.lo) : 0;
        (t.name === "full" ? full : reduced).liquid.style.fill = colour(f);
      }
      // How far apart the two rhythms are, from the recorded periods.
      gap.textContent =
        tf && tr
          ? `t = ${tau.toFixed(1)} (slow time). Full: ${(tau / tf).toFixed(1)} cycles, reduced: ${(tau / tr).toFixed(1)} cycles, gap ${(tau / tr - tau / tf).toFixed(2)} cycles.`
          : `t = ${tau.toFixed(1)} (slow time). A model that does not oscillate keeps one colour.`;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  return host;
}
