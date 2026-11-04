// Experiments run here so a stiff integration never freezes the page.

import { trace } from "@vibloom/chem";
import { runCheck, type CheckSpec } from "@vibloom/ideas";

type Request =
  | { id: number; spec: CheckSpec; scope: Record<string, number> }
  | {
      id: number;
      trace: {
        params: { s: number; q: number; eps: number; eps_prime: number };
        periods: Record<string, number>;
      };
    };

self.onmessage = (e: MessageEvent<Request>) => {
  const d = e.data;
  if ("trace" in d) {
    const out: Record<string, unknown> = {};
    for (const kind of ["full", "reduced"] as const) {
      const period = d.trace.periods[kind];
      if (period !== undefined) out[kind] = trace(kind, d.trace.params, period);
    }
    self.postMessage({ id: d.id, result: out });
    return;
  }
  self.postMessage({ id: d.id, result: runCheck(d.spec, d.scope) });
};
