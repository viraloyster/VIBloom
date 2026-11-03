import type { ClaimNode, ModelNode, ResultRecord } from "@vibloom/contracts";
import type { Job } from "./compute.worker";
import type { Verification } from "./verify";

type Series = { name: string; t: number[]; v: number[] }[];

// One worker for the page; each request gets an id and a promise.
const worker = new Worker(new URL("./compute.worker.ts", import.meta.url), { type: "module" });
const pending = new Map<number, (value: unknown) => void>();
let next = 0;
worker.onmessage = (e: MessageEvent<{ id: number; value: unknown }>) => {
  pending.get(e.data.id)?.(e.data.value);
  pending.delete(e.data.id);
};

type JobInput = Job extends infer J ? (J extends Job ? Omit<J, "id"> : never) : never;

function ask<T>(job: JobInput): Promise<T> {
  const id = ++next;
  return new Promise((resolve) => {
    pending.set(id, (v) => {
      resolve(v as T);
    });
    worker.postMessage({ ...job, id });
  });
}

export const verifyOffThread = (result: ResultRecord, claim: ClaimNode, model: ModelNode) =>
  ask<Verification>({ kind: "verify", result, claim, model });

export const signalOffThread = (
  models: ("full" | "reduced")[],
  claim: ClaimNode,
  model: ModelNode,
  point: Record<string, number>,
) => ask<Series>({ kind: "signal", models, claim, model, point });

export const catalystOffThread = (
  models: ("full" | "reduced")[],
  claim: ClaimNode,
  model: ModelNode,
  point: Record<string, number>,
) =>
  ask<{ name: "full" | "reduced"; t: number[]; z: number[] }[]>({
    kind: "catalyst",
    models,
    claim,
    model,
    point,
  });
