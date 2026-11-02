// The bench where the investigator is seen at work: its current move, what it
// predicted, what happened, what it learned, and a way to check any result.

import type { TraceEntry } from "@vibloom/agent";
import type { ClaimNode, ModelNode, ResultRecord } from "@vibloom/contracts";
import type { ProjectView, StoredInvestigation } from "./api";
import { el, fmt, pct, svg } from "./dom";
import { signal, verify } from "./verify";

export interface MonitorHandle {
  render(view: ProjectView, investigations: StoredInvestigation[]): void;
  focus(resultId: string | undefined): void;
}

function decisionCard(entry: TraceEntry | undefined): HTMLElement {
  const d = entry?.decision;
  if (!d) {
    return el(
      "div",
      { class: "card empty" },
      "No move yet. Ask a question to start an investigation.",
    );
  }
  const lines: (HTMLElement | null)[] = [
    el("div", { class: "move" }, d.action.replace("_", " ")),
    el("p", { class: "rationale" }, d.rationale),
  ];
  if (d.action === "run_point" || d.action === "stress_test") {
    if (d.action === "run_point") {
      lines.push(
        el(
          "p",
          {},
          el("b", {}, "Tells apart: "),
          `${d.distinguishes[0]}  vs  ${d.distinguishes[1]}`,
        ),
        el("p", {}, el("b", {}, "Point: "), JSON.stringify(d.point)),
      );
    }
    lines.push(
      el(
        "p",
        {},
        el("b", {}, "Predicted: "),
        `${d.prediction.outcome} - ${d.prediction.because}`,
        d.prediction.assumes.length > 0 ? ` (assumes ${d.prediction.assumes.join(", ")})` : "",
      ),
    );
  }
  if (d.action === "diagnose") {
    lines.push(
      el("p", {}, el("b", {}, "Lesson: "), d.lesson.statement),
      el(
        "ul",
        {},
        ...d.candidates.map((c) =>
          el("li", {}, `${c.id}: ${c.explanation} (blames ${c.suspects.join(", ")})`),
        ),
      ),
    );
  }
  if (d.action === "conclude") {
    lines.push(
      el("p", {}, el("b", {}, "Verdict: "), `${d.claim} ${d.verdict}`),
      el("p", { class: "interpretation" }, el("b", {}, "Interpretation: "), d.interpretation),
      el("p", {}, el("b", {}, "Limits: "), d.limits),
    );
  }
  if (entry.prediction) {
    lines.push(
      el(
        "div",
        { class: `verdict ${entry.prediction.verdict}` },
        entry.prediction.verdict === "surprise"
          ? `Surprise: expected ${entry.prediction.predicted}, observed ${entry.prediction.observed ?? "-"}`
          : entry.prediction.verdict === "as_predicted"
            ? `As predicted: ${entry.prediction.observed ?? "-"}`
            : "Undetermined",
      ),
    );
  }
  if (d.cites.length > 0) lines.push(el("p", { class: "cites" }, `cites ${d.cites.join(", ")}`));
  return el("div", { class: "card" }, ...lines);
}

function meter(investigations: StoredInvestigation[]): HTMLElement {
  const entries = investigations.flatMap((i) => i.investigation.trace);
  const count = (v: string) => entries.filter((e) => e.prediction?.verdict === v).length;
  const hit = count("as_predicted");
  const miss = count("surprise");
  const total = hit + miss;
  return el(
    "div",
    { class: "meter" },
    el("h3", {}, "Anticipation"),
    el(
      "div",
      { class: "bar" },
      el("span", { class: "hit", style: `flex:${String(hit || 0.0001)}` }),
      el("span", { class: "miss", style: `flex:${String(miss || 0.0001)}` }),
    ),
    el(
      "p",
      {},
      `${String(hit)} as predicted, ${String(miss)} surprises${total > 0 ? ` (${pct(hit / total)} anticipated)` : ""}, ${String(count("undetermined"))} undetermined`,
    ),
  );
}

function regionStrip(view: ProjectView, onPick: (id: string) => void): HTMLElement {
  const strips = view.nodes
    .filter((n): n is ClaimNode => n.kind === "claim" && n.predicate.kind === "FOR_ALL")
    .map((c) => {
      const range = c.predicate.kind === "FOR_ALL" ? c.predicate.region.s : undefined;
      if (!range) return null;
      const width = 600;
      const x = (s: number) => 10 + ((s - range.min) / (range.max - range.min)) * (width - 20);
      const marks = view.results
        .filter((r) => r.record.claim.id === c.id && r.record.point?.s !== undefined)
        .map(({ record, view: rv }) => {
          const dot = svg("circle", {
            cx: x(record.point?.s ?? 0).toFixed(1),
            cy: 18,
            r: 7,
            class: `mark ${record.outcome ?? "invalid"} ${rv.currency}`,
            tabindex: 0,
          });
          const title = svg("title");
          title.textContent = `s = ${fmt(record.point?.s)}: ${record.outcome ?? record.execution.status}, error ${pct(record.comparison?.relativeError)}`;
          dot.append(title);
          dot.addEventListener("click", () => {
            onPick(record.id);
          });
          return dot;
        });
      const verdict = view.claims.find((v) => v?.claim === c.id)?.verdict;
      return el(
        "div",
        { class: "strip" },
        el("div", { class: "strip-title" }, `${c.title}  [${verdict?.verdict ?? "-"}]`),
        svg(
          "svg",
          { viewBox: `0 0 ${String(width)} 36`, class: "strip-svg" },
          svg("line", { x1: 10, x2: width - 10, y1: 18, y2: 18, class: "axis" }),
          ...marks,
        ),
        el(
          "div",
          { class: "strip-axis" },
          el("span", {}, `s = ${fmt(range.min)}`),
          el("span", {}, `s = ${fmt(range.max)}`),
        ),
      );
    });
  return el("div", { class: "region" }, el("h3", {}, "Region map"), ...strips);
}

function plot(series: { name: string; t: number[]; v: number[] }[]): SVGSVGElement {
  const W = 600;
  const H = 160;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    for (const x of s.v) {
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
  }
  const tMax = Math.max(...series.map((s) => s.t[s.t.length - 1] ?? 1));
  const path = (s: { t: number[]; v: number[] }) =>
    s.t
      .map(
        (t, i) =>
          `${i === 0 ? "M" : "L"}${((t / tMax) * W).toFixed(1)},${(H - (((s.v[i] ?? lo) - lo) / (hi - lo || 1)) * H).toFixed(1)}`,
      )
      .join("");
  return svg(
    "svg",
    { viewBox: `0 0 ${String(W)} ${String(H)}`, class: "plot" },
    ...series.map((s) => svg("path", { d: path(s), class: `series ${s.name}` })),
  );
}

export function mountMonitor(host: HTMLElement): MonitorHandle {
  let view: ProjectView | undefined;
  let investigations: StoredInvestigation[] = [];
  let focused: string | undefined;
  const bench = el("div", { class: "bench" });

  function benchFor(r: ResultRecord | undefined) {
    if (!view || !r) {
      bench.replaceChildren(
        el("p", { class: "hint" }, "Pick a point on the region map to see the run."),
      );
      return;
    }
    const claim = view.nodes.find((n): n is ClaimNode => n.kind === "claim" && n.id === r.claim.id);
    const exp = view.experiments.find((e) => e.id === r.experiment.id);
    const m = view.nodes.find(
      (n): n is ModelNode => n.kind === "model" && n.id === exp?.spec.model.id,
    );
    const rows = (r.measurements ?? []).map((mm) =>
      el(
        "tr",
        {},
        el("td", {}, mm.model),
        el("td", {}, mm.observation),
        el("td", {}, fmt(mm.period, 5)),
      ),
    );
    const status = el("p", { class: "verify-status" });
    const button = el("button", { type: "button" }, "Verify it yourself");
    button.addEventListener("click", () => {
      if (!claim || !m) return;
      status.textContent = "Running the solver in your browser...";
      setTimeout(() => {
        const v = verify(r, claim, m);
        status.className = `verify-status ${v.agrees ? "ok" : "bad"}`;
        status.textContent = `${v.agrees ? "Matches the record" : "Differs from the record"}: outcome ${v.outcome.recomputed ?? "-"}, ${v.periods
          .map((p) => `${p.model} ${fmt(p.recomputed, 6)} (diff ${fmt(p.relativeDifference, 2)})`)
          .join(", ")}, ${v.ms.toFixed(0)} ms`;
      }, 20);
    });
    const plotHost = el("div", { class: "plot-host" });
    if (claim && m && r.point) {
      setTimeout(() => {
        const series = (["full", "reduced"] as const)
          .filter((k) => (r.measurements ?? []).some((mm) => mm.model === k))
          .map((k) => ({ name: k, ...signal(k, claim, m, r.point ?? {}) }));
        plotHost.replaceChildren(
          plot(series),
          el(
            "p",
            { class: "legend" },
            "log10 x over time: full model (bright) and reduced model (dim)",
          ),
        );
      }, 0);
    }
    bench.replaceChildren(
      el("h3", {}, `Run ${r.id}`),
      el(
        "p",
        {},
        `point ${JSON.stringify(r.point)}, ${r.ic ?? "-"}, outcome ${r.outcome ?? r.execution.status}`,
      ),
      el(
        "table",
        {},
        el("tr", {}, el("th", {}, "model"), el("th", {}, "observed"), el("th", {}, "period")),
        ...rows,
      ),
      el(
        "p",
        {},
        `relative period error ${pct(r.comparison?.relativeError)} against tolerance ${pct(r.comparison?.tolerance)}`,
      ),
      plotHost,
      button,
      status,
    );
  }

  function draw() {
    if (!view) return;
    const latest = investigations[investigations.length - 1]?.investigation;
    const lastMove = latest?.trace.filter((t) => t.accepted).at(-1);
    const lessons = view.lessons.filter((l) => l !== undefined);
    host.replaceChildren(
      el("h2", {}, "Monitor"),
      el(
        "div",
        { class: "monitor-grid" },
        el(
          "div",
          { class: "col" },
          el("h3", {}, "Current move"),
          decisionCard(lastMove),
          meter(investigations),
        ),
        el(
          "div",
          { class: "col" },
          regionStrip(view, (id) => {
            focused = id;
            benchFor(view?.results.find((x) => x.record.id === id)?.record);
          }),
          bench,
        ),
        el(
          "div",
          { class: "col" },
          el("h3", {}, "Lessons"),
          lessons.length === 0
            ? el("p", { class: "hint" }, "No lessons yet. They appear after a failed prediction.")
            : el(
                "ul",
                { class: "lessons" },
                ...lessons.map((l) =>
                  el(
                    "li",
                    { class: `lesson ${l.support.status} ${l.currency}` },
                    el("b", {}, l.id),
                    ` ${l.support.status.replace("_", " ")}${l.support.status === "supported" ? `: ${l.support.candidate}` : ""}, ${l.currency.replace("_", " ")}`,
                  ),
                ),
              ),
          el("h3", {}, "Evidence"),
          ...view.claims
            .filter((c) => c !== undefined)
            .map((c) => {
              const results = view?.results.filter((r) => r.record.claim.id === c.claim) ?? [];
              const current = results.filter((r) => r.view.currency === "current");
              return el(
                "p",
                { class: "evidence" },
                `${c.claim}: ${c.verdict.verdict.replace("_", " ")}, ${String(current.length)} current of ${String(results.length)} runs, ${String(current.filter((r) => r.record.outcome === "fails").length)} counterexamples`,
              );
            }),
        ),
      ),
    );
    benchFor(view.results.find((x) => x.record.id === focused)?.record);
  }

  return {
    render(v, inv) {
      view = v;
      investigations = inv;
      draw();
    },
    focus(id) {
      focused = id;
      draw();
    },
  };
}
