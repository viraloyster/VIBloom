// Falsification search over a claim region: Halton sampling, refinement
// between points that disagree, and reduction of a counterexample toward a
// reference point. Pure: the caller supplies the evaluation.

import type { RegionStatus } from "@vibloom/contracts";
import { halton, rotation } from "./halton";

export interface Dimension {
  name: string;
  min: number;
  max: number;
  scale: "linear" | "log";
}

export type Outcome = "holds" | "fails" | "inconclusive" | "not_applicable" | "invalid";
export type Stage = "sample" | "refine" | "reduce";
export type Point = Record<string, number>;

export interface Evaluated {
  point: Point;
  outcome: Outcome;
  stage: Stage;
}

export interface SearchPlan {
  dims: Dimension[];
  budget: number;
  seed: number;
  // Where reduction moves a counterexample toward; the region centre by default.
  reference?: Point;
}

export interface Reduction {
  // Objective: normalised distance to the reference inside the region, with
  // the failure reproduced at every accepted step.
  from: Point;
  point: Point;
  distance: number;
  steps: number;
  stopped: "budget" | "converged" | "inconclusive_zone" | "reference_fails";
}

export interface SearchReport {
  evaluated: Evaluated[];
  region: RegionStatus;
  reduced?: Reduction;
}

type Unit = number[];

function toPoint(dims: Dimension[], u: Unit): Point {
  const p: Point = {};
  dims.forEach((d, i) => {
    const x = u[i]!;
    p[d.name] =
      d.scale === "log"
        ? Math.exp(Math.log(d.min) + x * (Math.log(d.max) - Math.log(d.min)))
        : d.min + x * (d.max - d.min);
  });
  return p;
}

function toUnit(dims: Dimension[], p: Point): Unit {
  return dims.map((d) => {
    const v = p[d.name] ?? NaN;
    return d.scale === "log"
      ? (Math.log(v) - Math.log(d.min)) / (Math.log(d.max) - Math.log(d.min))
      : (v - d.min) / (d.max - d.min);
  });
}

const dist = (a: Unit, b: Unit) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]!) ** 2, 0));
const mid = (a: Unit, b: Unit) => a.map((x, i) => (x + b[i]!) / 2);

function checkPlan(plan: SearchPlan) {
  if (plan.dims.length === 0) throw new RangeError("a search needs at least one dimension");
  if (!(Number.isInteger(plan.budget) && plan.budget >= 1 && plan.budget <= 1000)) {
    throw new RangeError("budget must be an integer in [1, 1000]");
  }
  for (const d of plan.dims) {
    if (!(d.min < d.max) || (d.scale === "log" && !(d.min > 0))) {
      throw new RangeError(`bad range for ${d.name}`);
    }
  }
}

export function search(plan: SearchPlan, evaluate: (p: Point) => Outcome): SearchReport {
  checkPlan(plan);
  const { dims, budget } = plan;
  const done: (Evaluated & { u: Unit })[] = [];
  const run = (u: Unit, stage: Stage): Outcome => {
    const point = toPoint(dims, u);
    const outcome = evaluate(point);
    done.push({ point, outcome, stage, u });
    return outcome;
  };

  // Most of the budget samples the region; the rest refines and reduces.
  const shift = rotation(plan.seed, dims.length);
  const samples = Math.max(1, Math.ceil(budget * 0.6));
  let next = 1;
  const sample = () => run(halton(next++, dims.length, shift), "sample");
  while (next <= samples) sample();

  // Refine between the closest pairs that disagree, where the boundary is.
  const refineUntil = Math.min(budget, samples + Math.ceil(budget * 0.2));
  while (done.length < refineUntil) {
    let best: [Unit, Unit] | undefined;
    let bestD = Infinity;
    for (const a of done) {
      if (a.outcome !== "holds") continue;
      for (const b of done) {
        if (b.outcome !== "fails") continue;
        const d = dist(a.u, b.u);
        if (d < bestD && d > 1e-6) {
          bestD = d;
          best = [a.u, b.u];
        }
      }
    }
    const m = best ? mid(best[0], best[1]) : undefined;
    // Without a boundary to refine, keep sampling.
    if (!m || done.some((e) => dist(e.u, m) < 1e-9)) sample();
    else run(m, "refine");
  }

  let reduced: Reduction | undefined;
  const failures = done.filter((e) => e.outcome === "fails");
  if (failures.length > 0) {
    const ref = plan.reference ? toUnit(dims, plan.reference) : dims.map(() => 0.5);
    let bad = failures.reduce((a, b) => (dist(b.u, ref) < dist(a.u, ref) ? b : a)).u;
    const from = toPoint(dims, bad);
    let good = ref;
    let steps = 0;
    let stopped: Reduction["stopped"] = "budget";
    const refOutcome =
      done.find((e) => dist(e.u, ref) < 1e-9)?.outcome ??
      (done.length < budget ? run(ref, "reduce") : undefined);
    if (refOutcome === "fails") {
      bad = ref;
      stopped = "reference_fails";
    } else if (refOutcome === "holds") {
      while (done.length < budget) {
        if (dist(good, bad) < 1e-3) {
          stopped = "converged";
          break;
        }
        const m = mid(good, bad);
        const o = run(m, "reduce");
        if (o === "fails") {
          bad = m;
          steps++;
        } else if (o === "holds") good = m;
        else {
          // Never shrink across points the protocol could not classify.
          stopped = "inconclusive_zone";
          break;
        }
      }
    } else stopped = refOutcome === undefined ? "budget" : "inconclusive_zone";
    reduced = { from, point: toPoint(dims, bad), distance: dist(bad, ref), steps, stopped };
  }

  // Budget left after reduction (or with no counterexample) goes to sampling.
  while (done.length < budget) sample();

  const holds = done.filter((e) => e.outcome === "holds").length;
  const fails = done.filter((e) => e.outcome === "fails").length;
  const inconclusive = done.length - holds - fails;
  const region: RegionStatus =
    fails > 0
      ? {
          status: "counterexample_found",
          counterexamples: fails,
          evaluated: holds + fails,
          inconclusive,
        }
      : holds > 0
        ? { status: "no_counterexample", evaluated: holds, inconclusive }
        : { status: "unexplored" };

  const report: SearchReport = {
    evaluated: done.map(({ point, outcome, stage }) => ({ point, outcome, stage })),
    region,
  };
  if (reduced) report.reduced = reduced;
  return report;
}
