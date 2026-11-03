// Runs the solver off the page's main thread, so selection, zoom and the
// tree's animations never wait for an integration.

import type { ClaimNode, ModelNode, ResultRecord } from "@vibloom/contracts";
import { signal, verify } from "./verify";

export type Job =
  | { id: number; kind: "verify"; result: ResultRecord; claim: ClaimNode; model: ModelNode }
  | {
      id: number;
      kind: "signal";
      models: ("full" | "reduced")[];
      claim: ClaimNode;
      model: ModelNode;
      point: Record<string, number>;
    };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Job>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = (e) => {
  const job = e.data;
  if (job.kind === "verify") {
    scope.postMessage({ id: job.id, value: verify(job.result, job.claim, job.model) });
  } else {
    scope.postMessage({
      id: job.id,
      value: job.models.map((k) => ({ name: k, ...signal(k, job.claim, job.model, job.point) })),
    });
  }
};
