// Runs a check in a throwaway worker: no network, no storage, no access to the
// key, killed after a timeout.

import { CHECK_TIMEOUT_MS, toResult, type CheckResult } from "@vibloom/ideas";

interface Reply {
  ok: boolean;
  raw?: unknown;
  read?: Record<string, number>;
  error?: string;
}

export function runCheck(
  code: string,
  scope: Record<string, number>,
): Promise<CheckResult | { error: string }> {
  return new Promise((resolve) => {
    const w = new Worker(new URL("./check.worker.ts", import.meta.url), { type: "module" });
    const timer = setTimeout(() => {
      w.terminate();
      resolve({ error: `the check ran longer than ${String(CHECK_TIMEOUT_MS)} ms` });
    }, CHECK_TIMEOUT_MS);
    w.onmessage = (e: MessageEvent<Reply>) => {
      clearTimeout(timer);
      w.terminate();
      resolve(
        e.data.ok ? toResult(e.data.raw, e.data.read ?? {}) : { error: e.data.error ?? "failed" },
      );
    };
    w.postMessage({ code, scope });
  });
}
