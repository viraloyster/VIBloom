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
import { bench } from "./chem";
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
// The bench for an experiment is built once per run and kept, so its
// animation does not restart on every refresh.
let benchKey = "";
let benchEl: HTMLElement | undefined;

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
      result && n.check && n.check.kind !== "oregonator"
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
      const res = tree.results.get(id);
      // An experiment shows its own run: beakers and spiral dishes computed
      // from its exact values, not an illustration.
      if (n.check?.kind === "oregonator" && res && !("error" in res) && !tree.unconfirmed.has(id)) {
        const key = `${id}|${JSON.stringify(res.inputs)}|${String(res.value)}`;
        if (key !== benchKey || !benchEl) {
          benchKey = key;
          const restsOn = tree.ancestors(id).map((a) => a.title);
          benchEl = bench(id, res, restsOn);
        }
        shown = "";
        stage.replaceChildren(el("div", { class: "bench-stage" }, benchEl));
        side.replaceChildren(...instrument(tree, n, []));
        return;
      }
      const key = `${id}|${String(v?.html.length ?? 0)}|${JSON.stringify(data)}`;
      if (v) {
        if (key !== shown) {
          show(v.html, data);
          shown = key;
        }
        const redraw = el("button", { class: "ghost-btn", disabled: actions.busy() }, "Redraw");
        redraw.addEventListener("click", () => {
          actions.visualize(id);
        });
        stage.replaceChildren(
          frame,
          el(
            "p",
            { class: "provenance" },
            redraw,
            " ",
            `Illustration by Muse: ${v.title}. Not a simulation; the numbers and verdict are in the instrument.`,
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
    else if (r && tree.restates(n.id))
      out.push(
        el(
          "div",
          { class: "result error" },
          "This check only compares a number that was assumed for the outcome with its target, so it computes nothing. It is argued, not computed.",
        ),
      );
    else if (r && n.check?.kind === "oregonator")
      out.push(experiment(n.check.question, n.check.tolerance, r, tree.unconfirmed.has(n.id)));
    else if (r) {
      const backing = Object.keys(r.inputs).flatMap((k) => {
        const p = tree.param(k);
        return p ? [p] : [];
      });
      const st2 = tree.status(n.id);
      out.push(
        gauge(
          r,
          backing,
          st2 === "partial"
            ? "Some roots under it are only argued: the comparison passes, the backing is incomplete."
            : st2 === "unverified"
              ? "A root under it is stale or could not be evaluated."
              : st2 === "affected"
                ? "A root under it fails."
                : "Every root under it is computed and holds, or there are none.",
        ),
      );
    } else if (n.role !== "goal")
      out.push(el("p", { class: "fine" }, "No calculation: argued, not computed."));
    // Grouped by what changing the value would mean: only a design change
    // can fix a design; the others change the world or the goal.
    const flips = th.filter((t) => t.at !== undefined);
    if (flips.length) {
      const kinds: [string, string][] = [
        ["design", "A design change would flip it"],
        ["external", "Only if the world were different"],
        ["requirement", "Only if the goal changed"],
      ];
      out.push(el("p", { class: "eyebrow" }, "Where the verdict flips - computed, locally"));
      for (const [kind, label] of kinds) {
        const group = flips.filter((t) => (tree.param(t.name)?.kind ?? "external") === kind);
        if (group.length === 0) continue;
        out.push(
          el("p", { class: `flip-kind ${kind}` }, label),
          el(
            "ul",
            { class: "flips" },
            ...group.map((t) =>
              el(
                "li",
                {},
                el("b", {}, words(t.name)),
                ` ${t.holdsWhen === "above" ? "above" : "below"} about ${fmt(t.at ?? 0)}`,
                el("span", {}, ` now ${fmt(t.current)} (x${fmt((t.at ?? 0) / t.current)})`),
                t.single === false
                  ? el("em", {}, " flips back further out; no single threshold")
                  : null,
              ),
            ),
          ),
        );
      }
      out.push(
        el(
          "p",
          { class: "fine" },
          "Found by scanning 1e-4 to 1e4 times each value with the others fixed.",
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
    if (n.check && n.check.kind !== "oregonator") {
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
    // No edits while Muse is working: its answer must be about these values.
    const input = el("input", {
      type: "number",
      value: String(p.value),
      step: "any",
      "aria-label": p.name,
      disabled: actions.busy(),
    });
    input.addEventListener("change", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || v === p.value) return;
      // Editing a requirement changes the goal; say so before doing it.
      if (
        p.kind === "requirement" &&
        !confirm("This is a requirement: changing it changes the goal, not the design. Continue?")
      ) {
        input.value = String(p.value);
        return;
      }
      actions.setParam(
        p.name,
        v,
        p.kind === "external"
          ? "hypothetical: a person assumed a different world"
          : p.kind === "requirement"
            ? "goal changed by a person"
            : "design changed by a person",
      );
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
        el("span", { class: `kind ${p.kind}`, title: KIND_HELP[p.kind] }, p.kind),
        el(
          "span",
          { class: `origin ${p.origin}`, title: p.source || "chosen without a named source" },
          p.origin,
        ),
      ),
    );
  }
}

const QUESTIONS: Record<string, string> = {
  oscillates: "Does the full Oregonator oscillate here?",
  reduced_oscillates: "Does the two-variable reduction oscillate here?",
  reduction_keeps_period: "Does the reduction keep the full model's period?",
};

function experiment(question: string, tolerance: number, r: CheckResult, unconfirmed: boolean) {
  const p = r.sim?.periods ?? {};
  const o = r.sim?.observations ?? {};
  const line = (m: "full" | "reduced") =>
    o[m]
      ? el(
          "p",
          { class: "nums" },
          `${m}: ${o[m]}${p[m] !== undefined ? `, period ${fmt(p[m])}` : ""}`,
        )
      : null;
  return el(
    "div",
    { class: `result ${unconfirmed ? "" : r.pass ? "pass" : "fail"}` },
    el("p", { class: "eyebrow" }, "Experiment - Oregonator, stiff solver, robust protocol"),
    el("p", {}, QUESTIONS[question] ?? question),
    el(
      "p",
      { class: "verdict" },
      unconfirmed
        ? "Recorded; re-running in your browser..."
        : r.pass
          ? "Holds in this experiment"
          : "Fails in this experiment",
    ),
    line("full"),
    line("reduced"),
    question === "reduction_keeps_period"
      ? el(
          "p",
          { class: "nums" },
          `period difference ${fmt(r.value * 100)}% vs tolerance ${fmt(tolerance * 100)}%`,
        )
      : null,
    el(
      "p",
      { class: "fine" },
      `At s ${fmt(r.inputs.s ?? NaN)}, q ${fmt(r.inputs.q ?? NaN)}, eps ${fmt(r.inputs.eps ?? NaN)}, eps_prime ${fmt(r.inputs.eps_prime ?? NaN)}. Computed by VIBloom's chemistry engine, checked against SciPy; the question was chosen by Muse.`,
    ),
  );
}

const KIND_HELP: Record<Param["kind"], string> = {
  requirement: "What the goal demands; changing it changes the goal",
  design: "What the builder chooses",
  external: "How the world is; changing it is a hypothetical scenario",
};

// The verdict says only what the arithmetic shows: this comparison, with these
// values. Its backing and the conclusion it allows are spelled out apart.
function gauge(r: CheckResult, backing: Param[], premiseNote: string) {
  const ratio = r.limit === 0 ? 1 : Math.abs(r.value / r.limit);
  const unverified = backing.filter((p) => p.origin !== "reference" || p.source === "");
  const assumed = backing.filter((p) => p.origin === "assumed").length;
  return el(
    "div",
    { class: `result ${r.pass ? "pass" : "fail"}` },
    el("p", { class: "verdict" }, r.pass ? "Holds with these values" : "Fails with these values"),
    el(
      "p",
      { class: "nums" },
      `${fmt(r.value)} ${r.op} ${fmt(r.limit)} ${r.unit} is ${r.pass ? "true" : "false"}`,
    ),
    el(
      "div",
      { class: "bar" },
      el("i", { style: `width:${String(Math.min(1, ratio / 2) * 100)}%` }),
      el("b", { style: "left:50%" }),
    ),
    el(
      "dl",
      { class: "scope" },
      el("dt", {}, "Backing"),
      el(
        "dd",
        {},
        backing.length === 0
          ? "no values"
          : `${String(backing.length)} value${backing.length === 1 ? "" : "s"}: ${String(assumed)} assumed, ${String(backing.length - assumed)} with a source Muse named; none checked by a person`,
      ),
      el("dt", {}, "Premises"),
      el("dd", {}, premiseNote),
      el("dt", {}, "Allowed conclusion"),
      el(
        "dd",
        {},
        r.pass
          ? "With these values the assumption is consistent with its limit."
          : "With these values the assumption conflicts with its limit. It shows that this scenario fails, not that the idea is impossible.",
      ),
      unverified.length ? el("dt", {}, "Next") : null,
      unverified.length
        ? el(
            "dd",
            {},
            `Establish where ${unverified
              .map((p) => words(p.name))
              .slice(0, 3)
              .join(", ")} come from and when they apply.`,
          )
        : null,
    ),
  );
}
