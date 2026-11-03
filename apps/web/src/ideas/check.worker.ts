// Loaded from its own URL, so the page's policy does not apply to it; the
// lockdown below is what isolates the model's code.

import { evaluate, lockdown } from "@vibloom/ideas";

lockdown(self);

self.onmessage = (e: MessageEvent<{ code: string; scope: Record<string, number> }>) => {
  try {
    const { raw, read } = evaluate(e.data.code, e.data.scope);
    self.postMessage({ ok: true, raw, read });
  } catch (err) {
    self.postMessage({
      ok: false,
      error: String(err instanceof Error ? err.message : err).slice(0, 300),
    });
  }
};
