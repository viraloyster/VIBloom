// The recipe map: recipes near the tree's own, each run by the engine in this
// browser. A cell answers two questions in words: does the period meet the
// tree's own target, and does the two-variable reduction stay within the
// experiment's tolerance. Model results, not laboratory validation.

import { RECIPE_VERSION, SOLVER_VERSION } from "@vibloom/chem";
import {
  cellScope,
  recenter,
  verdict,
  type CheckError,
  type CheckResult,
  type IdeaTree,
  type MapSetup,
  type MapVerdict,
  type Recipe,
} from "@vibloom/ideas";
import { el } from "../dom";
import { simulate } from "./chem";
import { duration } from "./clock";

interface Cell {
  recipe: Recipe;
  run?: CheckResult | CheckError;
  v?: MapVerdict;
}

// One computation per recipe neighbourhood, kept while the page lives, so
// switching tabs does not start it again.
const cache = new Map<string, Cell[]>();

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const num = (x: number) => String(+x.toPrecision(3));
const short = (sec: number) => (sec < 100 ? `${sec.toFixed(0)} s` : `${(sec / 60).toFixed(1)} min`);

// A cell where another comparison of the tree fails at that recipe.
const broken = (c: Cell) => (c.v?.others ?? []).some((o) => "error" in o.result || !o.result.pass);

function state(c: Cell): { cls: string; label: string } {
  if (!c.run) return { cls: "pending", label: "computing" };
  if ("error" in c.run) return { cls: "none", label: "no conclusion" };
  const t = c.v?.meetsTarget;
  const a = c.v?.concordant;
  if (t && a) return { cls: "both", label: "meets the target; models agree" };
  if (t) return { cls: "target", label: "meets the target; reduction off" };
  if (a) return { cls: "agree", label: "models agree; period off target" };
  return { cls: "neither", label: "period off target; reduction off" };
}

// The map can be re-centred on any cell to explore further from the tree's
// recipe; the tree's recipe stays marked wherever it falls.
export function mapPanel(
  tree: IdeaTree,
  setup: MapSetup,
  use: (recipe: Recipe, run: CheckResult | CheckError) => void,
  busy: () => boolean,
): HTMLElement {
  const host = el("div", { class: "recipe-map-host" });
  const go = (s: MapSetup) => {
    host.replaceChildren(mapBody(tree, s, use, busy, go, setup));
  };
  go(setup);
  return host;
}

function mapBody(
  tree: IdeaTree,
  setup: MapSetup,
  use: (recipe: Recipe, run: CheckResult | CheckError) => void,
  busy: () => boolean,
  go: (s: MapSetup) => void,
  home: MapSetup,
): HTMLElement {
  const spec = setup.node.check;
  const tolerance = spec?.kind === "oregonator" ? spec.tolerance : NaN;
  const key = JSON.stringify([setup.recipe, setup.axes, setup.held, spec, setup.target?.check]);
  let cells = cache.get(key);
  if (!cells) {
    cells = setup.axes.bromate
      .slice()
      .reverse()
      .flatMap((bromate) =>
        setup.axes.malonic_acid.map((malonic_acid) => ({
          recipe: { ...setup.recipe, bromate, malonic_acid },
        })),
      );
    cache.set(key, cells);
  }
  const all = cells;
  const target = setup.target?.check;
  // Only acid and s reach the model besides the recipe; other numbers in the
  // tree (temperature, the target itself) are shown apart, as not modelled.
  const unit = (k: string) => {
    const u = tree.param(k)?.unit ?? "";
    return u && !["1", "-", "dimensionless", "none"].includes(u) ? ` ${u}` : "";
  };
  const shown = Object.entries(setup.held).filter(([k]) => !/_period_(full|reduced)(_s)?$/.test(k));
  const modelled = new Set(["acid", "s"]);
  const used = shown.filter(([k]) => modelled.has(k));
  const unused = shown.filter(([k]) => !modelled.has(k));
  const list = (xs: [string, number][]) =>
    xs.map(([k, v]) => `${k.replace(/_/g, " ")} ${num(v)}${unit(k)}`).join(", ");
  const fixed = el(
    "p",
    { class: "fine map-fixed" },
    `Fixed, as in the tree, and used by the model: ${list(used) || "none"}. Recipe conversion v${String(RECIPE_VERSION)}, solver v${String(SOLVER_VERSION)}, reduction tolerance ${pct(tolerance)}${target && target.kind !== "oregonator" ? `, target ${target.value} ${target.op} ${target.limit} ${target.unit}` : ", no period target in the tree"}.${unused.length ? ` Other values in the tree, not model inputs: ${list(unused)}.` : ""}`,
  );
  const grid = el("div", {
    class: "map-grid",
    style: `grid-template-columns: auto repeat(${String(setup.axes.malonic_acid.length)}, 1fr)`,
  });
  const evidence = el("div", { class: "map-evidence" });
  const progress = el("p", { class: "fine map-progress" });
  let chosen = all.findIndex(
    (c) =>
      c.recipe.bromate === setup.recipe.bromate &&
      c.recipe.malonic_acid === setup.recipe.malonic_acid,
  );

  const show = (i: number) => {
    chosen = i;
    for (const [k, b] of [...grid.querySelectorAll(".map-cell")].entries())
      b.classList.toggle("picked", k === i);
    const c = all[i];
    if (!c) return;
    const s = state(c);
    const here =
      c.recipe.bromate === setup.recipe.bromate &&
      c.recipe.malonic_acid === setup.recipe.malonic_acid;
    const rows: [string, string][] = [
      [
        "Recipe",
        `bromate ${num(c.recipe.bromate)} M, malonic acid ${num(c.recipe.malonic_acid)} M, acid ${num(c.recipe.acid)} M`,
      ],
    ];
    const sc = cellScope(tree, c.recipe);
    rows.push([
      "Model parameters",
      `q ${num(sc.q ?? NaN)}, eps ${num(sc.eps ?? NaN)}, eps_prime ${num(sc.eps_prime ?? NaN)}, time scale ${num(sc.time_scale_s ?? NaN)} s`,
    ]);
    if (c.run && !("error" in c.run)) {
      const ts = c.run.inputs.time_scale_s ?? NaN;
      const f = c.run.sim?.periods.full;
      const r = c.run.sim?.periods.reduced;
      rows.push([
        "Periods",
        `full ${f !== undefined ? duration(f * ts) : "-"}, two-variable ${r !== undefined ? duration(r * ts) : "-"}`,
      ]);
      rows.push([
        "Reduction",
        `models differ by ${pct(c.run.value)}, tolerance ${pct(tolerance)}: ${c.run.pass ? "agree" : "off"}`,
      ]);
      for (const o of c.v?.others ?? [])
        rows.push([
          o.title,
          "error" in o.result
            ? `could not evaluate: ${o.result.error}`
            : `${num(o.result.value)} ${o.result.op} ${num(o.result.limit)} ${o.result.unit}: ${o.result.pass ? "holds" : "fails"}`,
        ]);
      const t = c.v?.target;
      if (t)
        rows.push([
          "Target",
          "error" in t
            ? `could not evaluate: ${t.error}`
            : `${num(t.value)} ${t.op} ${num(t.limit)} ${t.unit}: ${t.pass ? "met" : "missed"}`,
        ]);
    } else if (c.run) rows.push(["Engine", c.run.error]);
    const pickBtn = el(
      "button",
      { class: "primary", disabled: here || !c.run || busy() },
      here ? "This is the tree's recipe" : "Use this recipe",
    );
    pickBtn.addEventListener("click", () => {
      if (c.run) use(c.recipe, c.run);
    });
    const centred =
      c.recipe.bromate === setup.axes.bromate[3] &&
      c.recipe.malonic_acid === setup.axes.malonic_acid[3];
    const around = el(
      "button",
      { class: "ghost-btn", disabled: centred },
      centred ? "Map centred here" : "Explore around this recipe",
    );
    around.addEventListener("click", () => {
      go(recenter(setup, c.recipe));
    });
    evidence.replaceChildren(
      el("p", { class: `map-state ${s.cls}` }, s.label),
      el("dl", {}, ...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])),
      el("div", { class: "row" }, pickBtn, around),
      el(
        "p",
        { class: "fine" },
        "Using it records the change and this run in the log; the other experiments then run with Muse predicting first. Predictions about what this run already settles are marked not blind.",
      ),
    );
  };

  const paint = () => {
    grid.replaceChildren(
      el("span", { class: "map-corner" }, "bromate \\ malonic (M)"),
      ...setup.axes.malonic_acid.map((m) => el("span", { class: "map-axis" }, num(m))),
    );
    setup.axes.bromate
      .slice()
      .reverse()
      .forEach((b, row) => {
        grid.append(el("span", { class: "map-axis" }, num(b)));
        setup.axes.malonic_acid.forEach((_, col) => {
          const i = row * setup.axes.malonic_acid.length + col;
          const c = all[i];
          if (!c) return;
          const s = state(c);
          const period = c.v?.periodS;
          const gap = c.run && !("error" in c.run) ? c.run.value : undefined;
          const here =
            c.recipe.bromate === setup.recipe.bromate &&
            c.recipe.malonic_acid === setup.recipe.malonic_acid;
          const btn = el(
            "button",
            {
              class: `map-cell ${s.cls}${here ? " here" : ""}${i === chosen ? " picked" : ""}${broken(c) ? " constrained" : ""}`,
              title: s.label,
              "aria-label": `bromate ${num(c.recipe.bromate)}, malonic acid ${num(c.recipe.malonic_acid)}: ${s.label}`,
            },
            el("b", {}, period !== undefined ? short(period) : c.run ? "-" : "..."),
            el("small", {}, gap !== undefined ? pct(gap) : ""),
          );
          btn.addEventListener("click", () => {
            show(i);
          });
          grid.append(btn);
        });
      });
    const done = all.filter((c) => c.run).length;
    progress.textContent =
      done < all.length
        ? `The engine is running ${String(all.length)} recipes in this browser: ${String(done)} done.`
        : `${String(all.length)} recipes run by the engine in this browser. Each cell: full-model period, and how far the two-variable model is off.`;
  };

  const back = el("button", { class: "ghost-btn" }, "Back to the tree's recipe");
  back.addEventListener("click", () => {
    go(home);
  });
  const panel = el(
    "div",
    { class: "recipe-map" },
    el(
      "div",
      { class: "map-head" },
      el("p", { class: "eyebrow" }, "Recipe map - nearby recipes, run by the engine"),
      setup === home ? null : back,
    ),
    fixed,
    el(
      "p",
      { class: "map-legend" },
      ...[
        ["both", "meets the target, models agree"],
        ["target", "meets the target, reduction off"],
        ["agree", "models agree, off target"],
        ["neither", "neither"],
      ].map(([cls, t]) => el("span", { class: `key ${cls ?? ""}` }, t ?? "")),
      el("span", { class: "key hatched" }, "faded: another check in the tree fails there"),
    ),
    grid,
    progress,
    evidence,
    el(
      "p",
      { class: "fine" },
      "Oregonator model results at the tree's fixed conditions; not laboratory validation. The map is computed here and not recorded; choosing a recipe records it.",
    ),
  );
  paint();
  if (chosen >= 0) show(chosen);

  // Cells run one after another in the worker, stopping if the panel leaves
  // the page; the cache keeps what is done.
  let seen = false;
  void (async () => {
    for (const c of all) {
      if (c.run) continue;
      if (panel.isConnected) seen = true;
      else if (seen) return;
      if (spec?.kind !== "oregonator") return;
      const run = await simulate(spec, cellScope(tree, c.recipe));
      c.run = run;
      c.v = verdict(tree, setup, c.recipe, run);
      paint();
      if (chosen >= 0) show(chosen);
    }
  })();
  return panel;
}
