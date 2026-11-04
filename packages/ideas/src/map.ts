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
  // How far the axes reach either way, as a factor of their centre.
  span: number;
  // What stays as the tree has it.
  held: Record<string, number>;
}

export interface MapVerdict {
  periodS?: number;
  concordant?: boolean;
  meetsTarget?: boolean;
  target?: CheckResult | CheckError;
  // The tree's other comparisons that change with the recipe, at this cell.
  others: { node: string; title: string; result: CheckResult | CheckError }[];
}

// Log-spaced values from value / span to value * span, the tree's value in
// the middle, so the current recipe is always a cell.
export function axis(value: number, n = 7, span = 10): number[] {
  const half = (n - 1) / 2;
  return Array.from({ length: n }, (_, i) => +(value * span ** ((i - half) / half)).toPrecision(3));
}

// The same map, centred on another recipe and closer in: each step takes the
// square root of the reach, so a narrow target band falls between fewer cells.
export function recenter(setup: MapSetup, center: Recipe): MapSetup {
  const span = Math.max(1.2, Math.sqrt(setup.span));
  return {
    ...setup,
    span,
    axes: {
      malonic_acid: axis(center.malonic_acid, 7, span),
      bromate: axis(center.bromate, 7, span),
    },
  };
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
    span: 10,
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
  if ("error" in run) return { others: [] };
  const ts = run.inputs.time_scale_s;
  const full = run.sim?.periods.full;
  const reduced = run.sim?.periods.reduced;
  const scope: Record<string, number> = cellScope(tree, recipe);
  // Every period name the tree's comparisons read, filled from this run.
  const moving = new Set<string>([...RECIPE_PARAMS, ...Object.keys(tree.derived())]);
  for (const n of tree.nodes.values()) {
    const c = n.check;
    if (!c || c.kind === "oregonator") continue;
    for (const name of periodNames(`${c.value} ${c.limit}`)) {
      const model = name.includes("_period_full") ? full : reduced;
      if (model === undefined) continue;
      scope[name] = name.endsWith("_s") ? model * (ts ?? NaN) : model;
      moving.add(name);
    }
  }
  const evaluate = (n: IdeaNode) => (n.check ? runCheck(n.check, scope) : undefined);
  const others = [...tree.nodes.values()].flatMap((n) => {
    const c = n.check;
    if (!c || c.kind === "oregonator" || n.id === setup.target?.id) return [];
    if (!safeNames(`${c.value} ${c.limit}`).some((x) => moving.has(x))) return [];
    const result = evaluate(n);
    return result ? [{ node: n.id, title: n.title, result }] : [];
  });
  const out: MapVerdict = {
    concordant: run.pass,
    others,
    ...(full !== undefined && ts !== undefined ? { periodS: full * ts } : {}),
  };
  const target = setup.target ? evaluate(setup.target) : undefined;
  if (!target) return out;
  return { ...out, target, ...("error" in target ? {} : { meetsTarget: target.pass }) };
}

function safeNames(src: string): string[] {
  try {
    return names(src);
  } catch {
    return [];
  }
}

function periodNames(src: string): string[] {
  return safeNames(src).filter((n) => /_period_(full|reduced)(_s)?$/.test(n));
}
