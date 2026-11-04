// The monitor: what is being tested in the selected root. Muse designs the
// visual (run in an isolated frame, fed only engine data); the instrument
// beside it is drawn by the code from the check and its thresholds.

import {
  thresholds,
  type CheckResult,
  type IdeaNode,
  type IdeaTree,
  type Param,
  type Status,
} from "@vibloom/ideas";
import { el } from "../dom";
import { statusLabel } from "./view";

export interface MonitorActions {
  visualize(id: string): void;
  expand(id: string): void;
  setParam(name: string, value: number, source: string): void;
  accept(id: string): void;
  reject(id: string): void;
  estimate(kind: "view" | "expand", id: string): number;
  busy(): boolean;
}

export const fmt = (x: number) =>
  Math.abs(x) >= 1e5 || (Math.abs(x) < 1e-2 && x !== 0)
    ? x.toExponential(2)
    : String(Math.round(x * 1000) / 1000);

const usd = (x: number) => (x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(3)}`);
const words = (name: string) => name.replace(/_/g, " ");

// Everything the view may show, taken from the engine, never from the model.
export function viewData(tree: IdeaTree, n: IdeaNode) {
  const r = tree.results.get(n.id);
  const result = r && !("error" in r) ? r : undefined;
  const scope = tree.scope();
  const names = [...n.params.map((p) => p.name), ...n.uses];
  return {
    goal: tree.goal,
    node: { title: n.title, statement: n.statement, status: tree.status(n.id) },
    params: names.flatMap((name) => {
      const p = tree.param(name);
      return p
        ? [{ name, label: words(name), value: p.value, unit: p.unit, origin: p.origin }]
        : [];
    }),
    check:
      result && n.check
        ? {
            value: result.value,
            limit: result.limit,
            op: result.op,
            unit: result.unit,
            pass: result.pass,
            description: n.check.description,
            thresholds: thresholds(n.check, scope, Object.keys(result.inputs)),
          }
        : null,
    children: tree.children(n.id).map((c) => ({ title: c.title, status: tree.status(c.id) })),
  };
}

export function mountMonitor(host: HTMLElement, actions: MonitorActions) {
  const frame = el("iframe", {
    class: "view-frame",
    sandbox: "allow-scripts",
    src: "frame.html",
    title: "View designed by Muse",
  });
  let pending: { html: string; data: unknown } | undefined;
  // The frame has an opaque origin, so "*" is the only target it accepts; it
  // only receives data, never anything secret.
  frame.addEventListener("load", () => {
    if (pending) frame.contentWindow?.postMessage(pending, "*");
  });
  // A fresh document per view, so nothing from the previous one survives.
  const show = (html: string, data: unknown) => {
    pending = { html, data };
    frame.src = `frame.html?${String(Date.now())}`;
  };

  const stage = el("div", { class: "stage-area" });
  const side = el("div", { class: "instrument" });
  const status = el("div", { class: "monitor-status" });
  host.replaceChildren(el("div", { class: "monitor-body" }, stage, side), status);
  let shown = "";

  return {
    status(text: string, live = false) {
      status.textContent = text;
      status.classList.toggle("live", live);
    },
    render(tree: IdeaTree, id: string | undefined) {
      if (!id || !tree.nodes.has(id)) {
        overview(tree);
        return;
      }
      const n = tree.nodes.get(id);
      if (!n) return;
      const v = tree.views.get(id);
      const data = viewData(tree, n);
      const key = `${id}|${String(v?.html.length ?? 0)}|${JSON.stringify(data)}`;
      if (v) {
        if (key !== shown) {
          show(v.html, data);
          shown = key;
        }
        stage.replaceChildren(
          frame,
          el(
            "p",
            { class: "provenance" },
            `${v.title} - designed by Muse, drawn from VIBloom's numbers`,
          ),
        );
      } else {
        shown = "";
        const b = el(
          "button",
          { class: "primary", disabled: actions.busy() || n.role === "goal" },
          "Visualize with Muse",
        );
        b.addEventListener("click", () => {
          actions.visualize(id);
        });
        stage.replaceChildren(
          el(
            "div",
            { class: "stage-empty" },
            el(
              "p",
              {},
              n.role === "goal"
                ? "Select a root to see what it tests."
                : "Muse can draw what this root is testing.",
            ),
            n.role === "goal"
              ? null
              : el(
                  "div",
                  { class: "row" },
                  b,
                  el(
                    "span",
                    { class: "fine" },
                    `about ${usd(actions.estimate("view", id))} at most`,
                  ),
                ),
          ),
        );
      }
      side.replaceChildren(...instrument(tree, n, data.check?.thresholds ?? []));
    },
  };

  function overview(tree: IdeaTree) {
    shown = "";
    const counts = new Map<Status, number>();
    for (const n of tree.nodes.values()) {
      if (n.role === "goal") continue;
      const s = tree.status(n.id);
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    stage.replaceChildren(
      el(
        "div",
        { class: "stage-empty" },
        el("p", { class: "eyebrow" }, "Goal"),
        el("h2", {}, tree.goal),
        el(
          "div",
          { class: "tally" },
          ...[...counts].map(([s, c]) =>
            el("span", { class: `pill ${s}` }, `${String(c)} ${statusLabel(s)}`),
          ),
        ),
        el("p", { class: "fine" }, "Select a root in the tree to test it here."),
      ),
    );
    side.replaceChildren();
  }

  function instrument(tree: IdeaTree, n: IdeaNode, th: ReturnType<typeof thresholds>) {
    const st = tree.status(n.id);
    const r = tree.results.get(n.id);
    const out: (Node | null)[] = [
      el("p", { class: `status ${st}` }, statusLabel(st)),
      el("h2", {}, n.title),
      el("p", { class: "statement" }, n.statement),
    ];
    if (r && "error" in r)
      out.push(el("div", { class: "result error" }, `Check could not run: ${r.error}`));
    else if (r) out.push(gauge(r, tree.assumedInputs(n.id).length));
    else if (n.role !== "goal")
      out.push(el("p", { class: "fine" }, "No calculation: argued, not computed."));
    const flips = th.filter((t) => t.at !== undefined);
    if (flips.length) {
      out.push(
        el("p", { class: "eyebrow" }, "Where it flips - computed"),
        el(
          "ul",
          { class: "flips" },
          ...flips.map((t) =>
            el(
              "li",
              {},
              el("b", {}, words(t.name)),
              ` ${t.holdsWhen === "above" ? ">=" : "<="} ${fmt(t.at ?? 0)}`,
              el("span", {}, ` now ${fmt(t.current)} (x${fmt((t.at ?? 0) / t.current)})`),
            ),
          ),
        ),
      );
    }
    const rows = [
      ...n.params.map((p) => row(p, false)),
      ...n.uses.flatMap((name) => {
        const p = tree.param(name);
        return p ? [row(p, true, tree.owner(name)?.title)] : [];
      }),
    ];
    if (rows.length)
      out.push(
        el("p", { class: "eyebrow" }, "Values"),
        el("table", { class: "params" }, el("tbody", {}, ...rows)),
      );
    for (const sg of n.suggestions) {
      const b = el("button", {}, "Adopt");
      b.addEventListener("click", () => {
        actions.setParam(sg.name, sg.value, `adopted from ${n.title}`);
      });
      out.push(
        el(
          "div",
          { class: "suggestion" },
          el(
            "span",
            {},
            `Muse suggests ${words(sg.name)} = ${fmt(sg.value)} ${sg.unit}`,
            sg.source ? el("small", {}, sg.source) : null,
          ),
          b,
        ),
      );
    }
    if (n.check) {
      out.push(
        el(
          "details",
          { class: "code" },
          el("summary", {}, "Formula by Muse, evaluated by VIBloom"),
          el("pre", {}, `${n.check.value}\n  ${n.check.op}\n${n.check.limit}`),
        ),
      );
    }
    if (n.proposed) {
      const a = el("button", {}, "Accept proposal");
      a.addEventListener("click", () => {
        actions.accept(n.id);
      });
      const x = el("button", {}, "Reject");
      x.addEventListener("click", () => {
        actions.reject(n.id);
      });
      out.push(el("div", { class: "row" }, a, x));
    }
    if (n.role !== "goal") {
      const b = el(
        "button",
        { class: "primary", disabled: actions.busy() || n.expanded },
        n.expanded ? "Opened" : "Open with Muse",
      );
      b.addEventListener("click", () => {
        actions.expand(n.id);
      });
      out.push(
        el(
          "div",
          { class: "row" },
          b,
          el("span", { class: "fine" }, `about ${usd(actions.estimate("expand", n.id))} at most`),
        ),
      );
    }
    return out.filter((x): x is Node => x !== null);
  }

  function row(p: Param, shared: boolean, from?: string) {
    const input = el("input", {
      type: "number",
      value: String(p.value),
      step: "any",
      "aria-label": p.name,
    });
    input.addEventListener("change", () => {
      const v = Number(input.value);
      if (Number.isFinite(v) && v !== p.value) actions.setParam(p.name, v, "set by a person");
    });
    return el(
      "tr",
      {},
      el(
        "td",
        { class: "pname" },
        words(p.name),
        shared && from ? el("small", {}, `shared, from ${from}`) : null,
      ),
      el("td", {}, input),
      el("td", { class: "unit" }, p.unit),
      el(
        "td",
        {},
        el(
          "span",
          { class: `origin ${p.origin}`, title: p.source || "chosen without a named source" },
          p.origin,
        ),
      ),
    );
  }
}

function gauge(r: CheckResult, assumed: number) {
  const ratio = r.limit === 0 ? 1 : Math.abs(r.value / r.limit);
  return el(
    "div",
    { class: `result ${r.pass ? "pass" : "fail"}` },
    el("p", { class: "verdict" }, r.pass ? "Holds - computed" : "Fails - computed"),
    el("p", { class: "nums" }, `${fmt(r.value)} ${r.op} ${fmt(r.limit)} ${r.unit}`),
    el(
      "div",
      { class: "bar" },
      el("i", { style: `width:${String(Math.min(1, ratio / 2) * 100)}%` }),
      el("b", { style: "left:50%" }),
    ),
    el("p", { class: "fine" }, "Formula and numbers come from Muse; the evaluation is VIBloom's."),
    assumed
      ? el(
          "p",
          { class: "fine warn" },
          `Rests on ${String(assumed)} assumed value${assumed === 1 ? "" : "s"}.`,
        )
      : null,
  );
}
