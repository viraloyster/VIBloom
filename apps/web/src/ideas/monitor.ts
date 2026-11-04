// The monitor: what is being tested in the selected root. Muse designs the
// visual (run in an isolated frame, fed only engine data); the instrument
// beside it is drawn by the code from the check and its thresholds.

import {
  thresholds,
  type CheckResult,
  type IdeaNode,
  type IdeaTree,
  type Lesson,
  type Param,
  type Status,
  mapSetup,
  type CheckError,
  type Recipe,
  type EventBody,
} from "@vibloom/ideas";
import { RECIPE_SOURCE } from "@vibloom/chem";
import { el } from "../dom";
import { clockPanel, duration } from "./clock";
import { mapPanel } from "./recipemap";
import type { Step } from "./process";

export interface Playback {
  recorded: boolean;
  playing: boolean;
  paused: boolean;
  pause: () => void;
  next: () => void;
  replay: () => void;
}
import { bench } from "./chem";
import { statusLabel } from "./view";

export interface MonitorActions {
  visualize(id: string): void;
  handwrite(id: string): void;
  investigate(id: string): void;
  expand(id: string): void;
  setParam(name: string, value: number, source: string): void;
  useRecipe(recipe: Recipe, run: CheckResult | CheckError): void;
  recordMap(body: Extract<EventBody, { type: "map" }>): void;
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
    // An experiment's run, with its periods already in seconds when the tree
    // has a recipe: the model's own units are not seconds.
    experiment:
      result && n.check?.kind === "oregonator"
        ? {
            question: n.check.question,
            tolerance: n.check.tolerance,
            outcome: result.pass ? "holds" : "fails",
            relative_difference: result.value,
            periods_model_units: result.sim?.periods,
            ...(result.inputs.time_scale_s !== undefined
              ? {
                  time_scale_s: result.inputs.time_scale_s,
                  periods_seconds: Object.fromEntries(
                    Object.entries(result.sim?.periods ?? {}).map(([k, v]) => [
                      k,
                      v * (result.inputs.time_scale_s ?? NaN),
                    ]),
                  ),
                }
              : {}),
          }
        : null,
    children: tree.children(n.id).map((c) => ({ title: c.title, status: tree.status(c.id) })),
  };
}

// Text Muse wrote for values that have since changed: said beside it, so a
// verdict about today's values is never read as about the quoted ones.
function writtenFor(tree: IdeaTree, id: string): HTMLElement[] {
  const stale = tree.staleText(id);
  if (!stale.length) return [];
  const unit = (k: string) => {
    const u = tree.param(k)?.unit ?? "";
    return u && u !== "1" ? ` ${u}` : "";
  };
  const fmt = (pick: (x: (typeof stale)[number]) => number) =>
    stale.map((x) => `${x.name.replace(/_/g, " ")} ${String(pick(x))}${unit(x.name)}`).join(", ");
  return [
    el(
      "p",
      { class: "written-for" },
      `Written for ${fmt((x) => x.then)}; the verdict below is for ${fmt((x) => x.now)}.`,
    ),
  ];
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
  let loaded: Promise<void> = Promise.resolve();
  let markLoaded = () => {};
  frame.addEventListener("load", () => {
    if (pending) frame.contentWindow?.postMessage(pending, "*");
    markLoaded();
  });
  // A fresh document per view, so nothing from the previous one survives.
  const show = (html: string, data: unknown) => {
    pending = { html, data };
    loaded = new Promise((resolve) => {
      // Give the drawing a moment to lay out and start moving.
      markLoaded = () => setTimeout(resolve, 1500);
    });
    frame.src = `frame.html?${String(Date.now())}`;
  };

  const stage = el("div", { class: "stage-area" });
  const side = el("div", { class: "instrument" });
  const status = el("div", { class: "monitor-status" });
  const body = el("div", { class: "monitor-body" }, stage, side);
  host.replaceChildren(body, status);
  let openStep = -1;
  // The process list follows its newest step until the person scrolls back.
  let following = true;
  let shown = "";

  // What the view frame shows right now, as an image, or undefined if the
  // frame does not answer in time.
  let asked = 0;
  // The time limit covers the whole operation, a frame that never finishes
  // loading included.
  const snapshot = () =>
    Promise.race([
      picture(),
      new Promise<undefined>((resolve) =>
        setTimeout(() => {
          resolve(undefined);
        }, 10000),
      ),
    ]);
  const picture = async () => {
    await loaded;
    return new Promise<string | undefined>((resolve) => {
      const id = ++asked;
      const done = (image?: string) => {
        window.removeEventListener("message", onMessage);
        clearTimeout(timer);
        resolve(image);
      };
      const onMessage = (e: MessageEvent) => {
        const d = e.data as { snapshot?: number; image?: unknown } | null;
        if (e.source !== frame.contentWindow || d?.snapshot !== id) return;
        done(
          typeof d.image === "string" && d.image.startsWith("data:image/") ? d.image : undefined,
        );
      };
      const timer = setTimeout(done, 6000);
      window.addEventListener("message", onMessage);
      frame.contentWindow?.postMessage({ snapshot: id }, "*");
    });
  };

  return {
    snapshot,
    status(text: string, live = false) {
      status.textContent = text;
      status.classList.toggle("live", live);
    },
    // The process behind the tree, newest last, one card per step. Cards are
    // buttons: focus or hover lights a step's roots, Enter or a click opens
    // it. The list follows the newest step unless the person scrolled back.
    process(list: Step[], mark: (ids: string[]) => void, play?: Playback) {
      shown = "";
      const cards = list.map((s, i) => {
        const card = el(
          "li",
          {
            class: `step ${s.actor}${s.tone ? ` ${s.tone}` : ""}${i === openStep ? " open" : ""}${play?.playing && i === list.length - 1 ? " current" : ""}`,
            tabindex: "0",
            role: "button",
            "aria-expanded": String(i === openStep),
          },
          el(
            "div",
            { class: "step-head" },
            el(
              "span",
              { class: "actor" },
              s.actor === "muse" ? "Muse" : s.actor === "engine" ? "Engine" : "You",
            ),
            el("span", { class: "stage" }, s.stage),
          ),
          el("p", { class: "step-title" }, s.title),
          s.badges?.length
            ? el(
                "p",
                { class: "badges" },
                ...s.badges.map((x) => el("span", { class: `badge ${x.tone}` }, x.text)),
              )
            : null,
          s.result ? el("p", { class: "step-result" }, s.result) : null,
          el(
            "dl",
            { class: "step-detail" },
            ...s.detail.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]),
          ),
        );
        const toggle = () => {
          openStep = openStep === i ? -1 : i;
          for (const [c, x] of cards.entries()) {
            x.classList.toggle("open", c === openStep);
            x.setAttribute("aria-expanded", String(c === openStep));
          }
        };
        card.addEventListener("click", toggle);
        card.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        });
        const light = () => {
          mark(s.nodes);
        };
        const dark = () => {
          mark([]);
        };
        card.addEventListener("mouseenter", light);
        card.addEventListener("mouseleave", dark);
        card.addEventListener("focus", light);
        card.addEventListener("blur", dark);
        return card;
      });
      const counts = (a: Step["actor"]) => list.filter((s) => s.actor === a).length;
      const refused = list.filter((s) => s.stage === "Refused").length;
      const controls: Node[] = [];
      if (play?.recorded) {
        controls.push(
          el("p", { class: "provenance" }, "Recorded Muse output - calculations running locally"),
        );
        const row = el("div", { class: "row play" });
        if (play.playing) {
          const pause = el("button", { class: "ghost-btn" }, play.paused ? "Resume" : "Pause");
          pause.addEventListener("click", play.pause);
          const next = el("button", { class: "ghost-btn" }, "Next step");
          next.addEventListener("click", play.next);
          row.append(pause, next);
        }
        const again = el("button", { class: "ghost-btn" }, "Replay");
        again.addEventListener("click", play.replay);
        row.append(again);
        controls.push(row);
      }
      const ol = el("ol", { class: "steps" }, ...cards);
      const jump = el("button", { class: "ghost-btn jump", hidden: true }, "Jump to latest");
      const timeline = el(
        "div",
        { class: "process" },
        el(
          "div",
          { class: "process-head" },
          el("p", { class: "eyebrow" }, "Process, from the log"),
          ...controls,
          el(
            "p",
            { class: "fine" },
            `${String(counts("muse"))} steps by Muse, ${String(counts("engine"))} by the engine (${String(refused)} refused), ${String(counts("person"))} by you. Muse proposes; the engine computes, runs and decides. Hover or focus a step to light its roots; open it for inputs, cost and log entry.`,
          ),
        ),
        ol,
        jump,
      );
      const before = body.querySelector<HTMLElement>(".process .steps");
      const atEnd = !before || before.scrollTop + before.clientHeight >= before.scrollHeight - 24;
      const keep = before?.scrollTop ?? 0;
      const focused = before?.contains(document.activeElement)
        ? [...before.children].indexOf(document.activeElement as Element)
        : -1;
      body.replaceChildren(timeline);
      if (following && atEnd) ol.scrollTop = ol.scrollHeight;
      else ol.scrollTop = keep;
      if (focused >= 0)
        (ol.children[focused] as HTMLElement | undefined)?.focus({ preventScroll: true });
      const sync = () => {
        const end = ol.scrollTop + ol.clientHeight >= ol.scrollHeight - 24;
        following = end;
        jump.hidden = end;
      };
      ol.addEventListener("scroll", sync, { passive: true });
      jump.addEventListener("click", () => {
        following = true;
        ol.scrollTop = ol.scrollHeight;
      });
      sync();
    },
    render(tree: IdeaTree, id: string | undefined) {
      // Animations stop when taken off screen, so a bench coming back from
      // the process view is built again rather than shown frozen.
      if (body.firstChild !== stage) {
        body.replaceChildren(stage, side);
        benchEl = undefined;
      }
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
          const setup = mapSetup(tree);
          benchEl = tabs(
            [
              ["The clock", () => clockPanel(res)],
              ["Spiral waves", () => bench(id, res, restsOn)],
              ...(typeof setup === "string"
                ? []
                : ([
                    [
                      "Recipe map",
                      () =>
                        mapPanel(
                          tree,
                          setup,
                          (r, run) => {
                            actions.useRecipe(r, run);
                          },
                          () => actions.busy(),
                          (body) => {
                            actions.recordMap(body);
                          },
                        ),
                    ],
                  ] as [string, () => HTMLElement][])),
            ],
            res.inputs.time_scale_s !== undefined ? 0 : 1,
          );
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
        const provenance = el(
          "p",
          { class: "provenance" },
          redraw,
          " ",
          `Illustration by Muse: ${v.title}. Not a simulation; the numbers and verdict are in the instrument.`,
          reviewNote(tree.reviews.get(id)),
        );
        // Moving an iframe reloads it: keep it in place and swap only the line.
        if (stage.firstChild === frame && stage.childNodes.length === 2) {
          stage.lastChild?.replaceWith(provenance);
        } else {
          stage.replaceChildren(frame, provenance);
        }
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
        tree.sketch
          ? el(
              "figure",
              { class: "sketch-figure" },
              el("img", { class: "handwriting", src: tree.sketch, alt: "The handwritten goal" }),
              el("figcaption", { class: "fine" }, "Written by hand; Muse read the goal from this."),
            )
          : null,
        el(
          "div",
          { class: "tally" },
          ...[...counts].map(([s, c]) =>
            el("span", { class: `pill ${s}` }, `${String(c)} ${statusLabel(s)}`),
          ),
        ),
        predictionsLine(tree),
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
      n.check?.kind === "oregonator" ? glance(tree, n) : null,
      el("p", { class: "statement" }, n.statement),
      ...writtenFor(tree, n.id),
    ];
    if (r && "error" in r)
      out.push(el("div", { class: "result error" }, `Check could not run: ${r.error}`));
    else if (r && tree.circular(n.id)) {
      const claimed = tree.assumedOutcome(n.id);
      out.push(
        el(
          "div",
          { class: "result error" },
          claimed
            ? `The result this check claims (${words(claimed)}) is an assumed number, not measured or computed, so the conclusion is only conditional. It is argued, not computed.`
            : "This check only compares a number that was assumed for the outcome with its target, so it computes nothing. It is argued, not computed.",
        ),
      );
    } else if (r && n.check?.kind === "oregonator")
      out.push(
        experiment(
          n.check.question,
          n.check.tolerance,
          r,
          tree.latestRun(n.id)?.state ?? "confirmed",
        ),
      );
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
    if (n.overridden?.length)
      out.push(
        el(
          "p",
          { class: "fine warn" },
          `Muse also gave ${n.overridden.map(words).join(", ")}; the recipe sets ${n.overridden.length > 1 ? "them" : "it"}, so ${n.overridden.length > 1 ? "those values were" : "that value was"} not used.`,
        ),
      );
    const derived = tree.derived();
    if (n.check?.kind === "oregonator" && Object.keys(derived).length) {
      const label: Record<string, string> = {
        q: "q",
        eps: "eps",
        eps_prime: "eps prime",
        time_scale_s: "seconds per model time unit",
        recipe_version: "conversion version",
      };
      out.push(
        el("p", { class: "eyebrow" }, "Computed from the recipe"),
        el(
          "table",
          { class: "params derived" },
          el(
            "tbody",
            {},
            ...Object.entries(derived).map(([k, v]) =>
              el(
                "tr",
                {},
                el("td", {}, label[k] ?? k),
                el("td", { class: "num" }, fmt(v)),
                el("td", {}, el("span", { class: "badge" }, "derived")),
              ),
            ),
          ),
        ),
        el(
          "p",
          { class: "fine" },
          `From bromate, malonic acid and acid with ${RECIPE_SOURCE}. Edit the recipe, not these.`,
        ),
      );
    }
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
    if (n.check?.kind === "oregonator") out.push(...investigation(tree, n));
    if (n.check && n.check.kind !== "oregonator") {
      const byHand = n.check.description.startsWith("Written by hand:");
      out.push(
        el(
          "details",
          { class: "code", open: byHand },
          el(
            "summary",
            {},
            byHand
              ? "Your handwritten formula, read by Muse, evaluated by VIBloom"
              : "Formula by Muse, evaluated by VIBloom",
          ),
          byHand && tree.handwriting.has(n.id)
            ? el("img", {
                class: "handwriting",
                src: tree.handwriting.get(n.id),
                alt: "The handwritten formula",
              })
            : null,
          byHand ? el("p", { class: "fine" }, n.check.description) : null,
          el("pre", {}, `${n.check.value}\n  ${n.check.op}\n${n.check.limit}`),
        ),
      );
    }
    if (n.role !== "goal" && n.check?.kind !== "oregonator") {
      const w = el(
        "button",
        { class: "ghost-btn", disabled: actions.busy() },
        "Write a formula by hand",
      );
      w.addEventListener("click", () => {
        actions.handwrite(n.id);
      });
      out.push(
        el(
          "div",
          { class: "row" },
          w,
          el("span", { class: "fine" }, "Muse reads it; the engine computes it."),
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

  // Predictions against runs, and the lessons the surprises left.
  function investigation(tree: IdeaTree, n: IdeaNode): Node[] {
    const out: Node[] = [el("p", { class: "eyebrow" }, "Investigation")];
    const go = el(
      "button",
      { class: "primary", disabled: actions.busy() },
      "Predict and run again",
    );
    go.addEventListener("click", () => {
      actions.investigate(n.id);
    });
    out.push(
      el("div", { class: "row" }, go),
      el(
        "p",
        { class: "fine" },
        tree.results.has(n.id)
          ? "Muse predicts before every run on its own. A run of these values is already in the log, so a prediction made now is kept but not scored."
          : "Muse predicts first; the engine runs; a surprise makes Muse propose two explanations and one more run decides between them.",
      ),
    );
    for (const p of tree.predictions.filter((x) => x.node === n.id)) {
      const v = tree.verdict(p.run);
      const settled = v === "holds" || v === "fails";
      const right = settled && v === p.expect;
      out.push(
        el(
          "p",
          { class: `predict ${settled ? (right ? "right" : "wrong") : ""}` },
          `${p.id}: predicted ${p.expect} (${String(Math.round(p.confidence * 100))}%)`,
          settled
            ? right
              ? " - right"
              : ` - wrong, it ${v}`
            : v === "pending"
              ? " - run re-checking here"
              : v === "failed"
                ? " - its run did not reproduce"
                : " - not run yet",
          p.uses.length ? el("small", {}, ` using ${p.uses.join(", ")}`) : null,
          p.unsupported.length
            ? el(
                "small",
                { class: "warn" },
                ` (reason cites ${p.unsupported.join(", ")}, not in its data)`,
              )
            : null,
        ),
      );
    }
    for (const l of tree.lessons.filter((x) => x.node === n.id)) {
      const state = tree.lessonState(l);
      const d = tree.decided(l);
      const at = Object.entries(l.basis)
        .map(([k, v]) => `${k} ${fmt(v)}`)
        .join(", ");
      out.push(
        el(
          "div",
          { class: `lesson ${state}` },
          el("p", { class: "eyebrow" }, `${l.id} - ${state}`),
          el("p", { class: "label" }, "Verified by the engine"),
          el(
            "p",
            { class: "finding" },
            `${l.prediction} expected ${tree.predictions.find((x) => x.id === l.prediction)?.expect ?? "?"}; at ${at} it ${l.observed}${measured(tree, l.surprise)}.`,
            d
              ? ` ${intervention(l)}, it ${d.outcome}${measured(tree, l.run)}.`
              : ` Test registered first: ${words(l.test.param)} = ${fmt(l.test.value)}${state === "failed" ? ", which did not conclude or reproduce" : ", not decided yet"}.`,
          ),
          el("p", { class: "label" }, "Muse's interpretations, before the test"),
          ...l.candidates.map((c, i) =>
            el(
              "p",
              { class: d ? (i === d.supported ? "supported" : "refuted") : "" },
              d
                ? i === d.supported
                  ? "Consistent with the test, of the two considered: "
                  : "Contradicted by the test: "
                : "",
              c.explanation,
              c.scope ? el("small", {}, ` (scope: ${c.scope})`) : null,
            ),
          ),
          l.open ? el("p", { class: "fine" }, el("strong", {}, "Still open: "), l.open) : null,
          l.unsupported.length
            ? el(
                "p",
                { class: "fine warn" },
                `Numbers Muse wrote that were not in its data: ${l.unsupported.join(", ")}.`,
              )
            : null,
          el(
            "p",
            { class: "fine" },
            "One test tells the two explanations considered apart; it does not prove a cause, and others were not considered.",
          ),
          state === "invalidated"
            ? el(
                "p",
                { class: "fine warn" },
                "A premise it was learned under has changed: this lesson no longer applies as it stands.",
              )
            : null,
        ),
      );
    }
    return out;
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

// What the test changed, and whether a person could mix it.
function intervention(l: Lesson): string {
  const at = `${words(l.test.param)} = ${fmt(l.test.value)}`;
  return l.intervention === "recipe"
    ? `Recipe change, ${at} M (every model parameter re-derived)`
    : l.recipe
      ? `Model change, ${at} (no recipe is shown to realize it)`
      : `With ${at} instead`;
}

// The number behind a run's verdict, so a binary outcome never hides how far
// it moved (a 401% gap that falls to 13% still "fails" a 5% tolerance).
function measured(tree: IdeaTree, seq: number | undefined): string {
  const run = tree.runs.find((r) => r.seq === seq);
  const spec = run && tree.nodes.get(run.node)?.check;
  if (!run || "error" in run.result || spec?.kind !== "oregonator") return "";
  if (spec.question !== "reduction_keeps_period") return "";
  return ` (period difference ${fmt(run.result.value * 100)}%, tolerance ${fmt(spec.tolerance * 100)}%)`;
}

// Views of one run, built when first opened.
function tabs(views: [string, () => HTMLElement][], first: number): HTMLElement {
  const body = el("div", { class: "tab-body" });
  const buttons = views.map(([label], i) => {
    const b = el("button", { class: "tab" }, label);
    b.addEventListener("click", () => {
      open(i);
    });
    return b;
  });
  const open = (i: number) => {
    const make = views[i]?.[1];
    if (!make) return;
    // Built fresh each time: a panel's animation ends once it leaves the page.
    body.replaceChildren(make());
    buttons.forEach((b, k) => b.classList.toggle("on", k === i));
  };
  open(first);
  return el("div", { class: "tabs" }, el("div", { class: "tab-row" }, ...buttons), body);
}

// What happened, before why to trust it: the period, the target and the
// reduction's error, each with its verdict in words. Details follow below.
function glance(tree: IdeaTree, n: IdeaNode): HTMLElement | null {
  const r = tree.results.get(n.id);
  if (!r || "error" in r || tree.unconfirmed.has(n.id)) return null;
  const rows: HTMLElement[] = [];
  const ts = r.inputs.time_scale_s;
  const full = r.sim?.periods.full;
  if (full !== undefined)
    rows.push(
      el(
        "p",
        { class: "big" },
        ts === undefined ? `Period ${full.toPrecision(3)} (model units)` : duration(full * ts),
      ),
    );
  // Any comparison that reads a period in seconds: a target on the clock.
  for (const m of tree.nodes.values()) {
    const c = m.check;
    const res = tree.results.get(m.id);
    if (!c || c.kind === "oregonator" || !res || "error" in res) continue;
    if (!/_period_(full|reduced)_s\b/.test(`${c.value} ${c.limit}`)) continue;
    rows.push(
      el(
        "p",
        { class: res.pass ? "ok" : "bad" },
        `${m.title}: ${res.value.toPrecision(3)} ${res.op} ${res.limit.toPrecision(3)} ${res.unit} - ${res.pass ? "meets it" : "misses it"}`,
      ),
    );
  }
  for (const m of tree.nodes.values()) {
    const c = m.check;
    const res = tree.results.get(m.id);
    if (c?.kind !== "oregonator" || c.question !== "reduction_keeps_period") continue;
    if (!res || "error" in res) continue;
    rows.push(
      el(
        "p",
        { class: res.pass ? "ok" : "bad" },
        `Reduction error ${(res.value * 100).toFixed(1)}%, allowed ${(c.tolerance * 100).toFixed(0)}% - ${res.pass ? "holds" : "fails"}`,
      ),
    );
  }
  return rows.length ? el("div", { class: "glance" }, ...rows) : null;
}

// What Muse said after looking at a picture of its own drawing.
function reviewNote(r: { ok: boolean; problems: string[]; redrawn: boolean } | undefined) {
  if (!r) return null;
  return el(
    "span",
    { class: `review ${r.ok ? "ok" : "warn"}` },
    r.ok
      ? ` Muse looked at this drawing and found it matches the data${r.redrawn ? ", after one redraw" : ""}.`
      : ` Muse looked at this drawing and found: ${r.problems.join("; ")}.`,
  );
}

// Accuracy over settled predictions, with the Brier score that also weighs
// the stated confidence; calibration needs many more than a demo makes.
function predictionsLine(tree: IdeaTree) {
  const c = tree.calibration();
  if (!c.made && !c.pending) return null;
  const parts = [
    `Muse's predictions: ${String(c.right)} of ${String(c.made)} right`,
    c.brier !== undefined ? `Brier score ${c.brier.toFixed(2)} (0 best, 0.25 a coin flip)` : "",
    c.pending ? `${String(c.pending)} re-checking here` : "",
    `${String(tree.lessons.filter((l) => tree.decided(l)).length)} lesson(s) decided`,
  ];
  return el("p", { class: "fine" }, parts.filter(Boolean).join("; ") + ".");
}

function experiment(
  question: string,
  tolerance: number,
  r: CheckResult,
  state: "unconfirmed" | "confirmed" | "failed",
) {
  const unconfirmed = state !== "confirmed";
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
      state === "failed"
        ? "Recorded, but it did not reproduce in your browser: not counted"
        : unconfirmed
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
