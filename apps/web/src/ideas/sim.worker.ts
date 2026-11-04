// Experiments run here so a stiff integration never freezes the page.

import { runCheck, type CheckSpec } from "@vibloom/ideas";

self.onmessage = (
  e: MessageEvent<{ id: number; spec: CheckSpec; scope: Record<string, number> }>,
) => {
  self.postMessage({ id: e.data.id, result: runCheck(e.data.spec, e.data.scope) });
};
