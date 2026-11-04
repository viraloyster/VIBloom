// Recipes near the tree's own: for each, the engine's run of the reduction
// experiment and the tree's own period target, evaluated at that recipe. The
// map is exploration computed by the engine, not a record; choosing a recipe
// puts that recipe and its run into the log.

import { RECIPE_PARAMS, recipeDerived, runCheck } from "./check";
import { names } from "./expr";
import type { IdeaTree } from "./tree";
import type { CheckError, CheckResult, IdeaNode } from "./types";

export type Recipe = Record<(typeof RECIPE_PARAMS)[number], number>;

export interface MapSetup {
  // The experiment whose run each cell repeats: the reduction question.
  node: IdeaNode;
  // The comparison that reads the period, if the tree has one.
  target?: IdeaNode;
  recipe: Recipe;
  axes: { malonic_acid: number[]; bromate: number[] };
  // What stays as the tree has it.
  held: Record<string, number>;
}

export interface MapVerdict {
  periodS?: number;
  concordant?: boolean;
  meetsTarget?: boolean;
  target?: CheckResult | CheckError;
}

// Log-spaced values from value / span to value * span, the tree's value in
// the middle, so the current recipe is always a cell.
export function axis(value: number, n = 7, span = 4): number[] {
  const half = (n - 1) / 2;
  return Array.from({ length: n }, (_, i) => +(value * span ** ((i - half) / half)).toPrecision(3));
}

// What a map needs from the tree, or why it cannot be drawn.
export function mapSetup(tree: IdeaTree): MapSetup | string {
  const scope = tree.scope();
  if (!RECIPE_PARAMS.every((k) => scope[k] !== undefined)) return "the tree has no recipe";
  const node = [...tree.nodes.values()].find(
    (n) => n.check?.kind === "oregonator" && n.check.question === "reduction_keeps_period",
  );
  if (!node) return "the tree has no experiment on whether the reduction keeps the period";
  const target = [...tree.nodes.values()].find(
    (n) =>
      n.check &&
      n.check.kind !== "oregonator" &&
      periodNames(`${n.check.value} ${n.check.limit}`).length > 0,
  );
  const recipe = Object.fromEntries(RECIPE_PARAMS.map((k) => [k, scope[k] ?? NaN])) as Recipe;
  const derived = new Set(Object.keys(tree.derived()));
  const kept = Object.fromEntries(
    Object.entries(scope).filter(
      ([k]) =>
        !derived.has(k) &&
        k !== "bromate" &&
        k !== "malonic_acid" &&
        !/_period_(full|reduced)(_s)?$/.test(k),
    ),
  );
  return {
    node,
    ...(target ? { target } : {}),
    recipe,
    axes: { malonic_acid: axis(recipe.malonic_acid), bromate: axis(recipe.bromate) },
    held: kept,
  };
}

// The values an experiment at this recipe runs with: the tree's scope with
// the recipe changed and every model parameter re-derived from it.
export function cellScope(tree: IdeaTree, recipe: Recipe): Record<string, number> {
  const scope = { ...tree.scope() };
  for (const k of Object.keys(tree.derived())) Reflect.deleteProperty(scope, k);
  return { ...scope, ...recipe, ...recipeDerived({ ...scope, ...recipe }) };
}

export function runCell(tree: IdeaTree, setup: MapSetup, recipe: Recipe) {
  if (setup.node.check?.kind !== "oregonator") throw new Error("not an experiment");
  return runCheck(setup.node.check, cellScope(tree, recipe));
}

// The two questions the map answers at a cell, from the run alone: does the
// reduction stay within the experiment's tolerance, and does the tree's own
// period target hold there, evaluated by the engine with the run's periods.
export function verdict(
  tree: IdeaTree,
  setup: MapSetup,
  recipe: Recipe,
  run: CheckResult | CheckError,
): MapVerdict {
  if ("error" in run) return {};
  const ts = run.inputs.time_scale_s;
  const full = run.sim?.periods.full;
  const reduced = run.sim?.periods.reduced;
  const out: MapVerdict = {
    concordant: run.pass,
    ...(full !== undefined && ts !== undefined ? { periodS: full * ts } : {}),
  };
  const spec = setup.target?.check;
  if (!spec || spec.kind === "oregonator" || full === undefined) return out;
  const scope: Record<string, number> = cellScope(tree, recipe);
  for (const name of periodNames(`${spec.value} ${spec.limit}`)) {
    const model = name.includes("_period_full") ? full : reduced;
    if (model === undefined) return out;
    scope[name] = name.endsWith("_s") ? model * (ts ?? NaN) : model;
  }
  const target = runCheck(spec, scope);
  return { ...out, target, ...("error" in target ? {} : { meetsTarget: target.pass }) };
}

function periodNames(src: string): string[] {
  try {
    return names(src).filter((n) => /_period_(full|reduced)(_s)?$/.test(n));
  } catch {
    return [];
  }
}
