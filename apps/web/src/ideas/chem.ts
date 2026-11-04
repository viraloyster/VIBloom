// The chemistry bench inside the idea tree: the experiment's own run, shown
// as twin beakers and spiral-wave dishes computed from its exact values.

import type { Trace } from "@vibloom/chem";
import type { ClaimNode, ModelNode, ResultRecord } from "@vibloom/contracts";
import type { CheckResult, CheckSpec } from "@vibloom/ideas";
import { twinBeakers } from "../beakers";

const worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
const pending = new Map<number, (r: never) => void>();
let next = 0;
worker.onmessage = (e: MessageEvent<{ id: number; result: never }>) => {
  pending.get(e.data.id)?.(e.data.result);
  pending.delete(e.data.id);
};

export function simulate(
  spec: CheckSpec,
  scope: Record<string, number>,
): Promise<CheckResult | { error: string }> {
  const id = ++next;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ id, spec, scope });
  });
}

// The run's concentrations over three periods of each model, for drawing.
export function traces(r: CheckResult): Promise<{ full?: Trace; reduced?: Trace }> {
  const { s = NaN, q = NaN, eps = NaN, eps_prime = NaN } = r.inputs;
  const id = ++next;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({
      id,
      trace: { params: { s, q, eps, eps_prime }, periods: { ...r.sim?.periods } },
    });
  });
}

// The bench components were written for the chemistry engine's records; the
// experiment carries the same numbers, so it is adapted rather than redrawn.
export function bench(nodeId: string, r: CheckResult, restsOn: string[]): HTMLElement {
  const { s = NaN, q = NaN, eps = NaN, eps_prime = NaN } = r.inputs;
  const periods = r.sim?.periods ?? {};
  const record = {
    id: nodeId,
    point: { s, eps_prime },
    ic: "far",
    measurements: (["full", "reduced"] as const).map((m) => ({ model: m, period: periods[m] })),
    comparison: { relativeError: r.value },
  } as unknown as ResultRecord;
  const claim = { predicate: { ic: "far" } } as unknown as ClaimNode;
  const model = { id: "oregonator", revision: 1, params: { q, eps } } as unknown as ModelNode;
  return twinBeakers(record, claim, model, restsOn);
}
