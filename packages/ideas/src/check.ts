// Running a check the model wrote: the code sees only a read-only view of the
// parameters in scope, and the result is validated before it is recorded.

import type { CheckResult } from "./types";

export const CHECK_TIMEOUT_MS = 3000;

const BLOCKED = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "importScripts",
  "indexedDB",
  "caches",
  "BroadcastChannel",
  "Worker",
];

// Removes network and storage from a worker before any model code runs, on
// the global and on its prototypes. The worker never holds the key; this keeps
// a check from reaching anything at all.
export function lockdown(scope: object) {
  for (
    let o: object | null = scope;
    o && o !== Object.prototype;
    o = Object.getPrototypeOf(o) as object | null
  ) {
    for (const k of BLOCKED) {
      try {
        Object.defineProperty(o, k, { value: undefined, configurable: false, writable: false });
      } catch {
        // Already absent or locked.
      }
    }
  }
}

// Evaluates the body of `function (p) { ... }` and records which parameters it read.
export function evaluate(
  code: string,
  scope: Record<string, number>,
): { raw: unknown; read: Record<string, number> } {
  const read: Record<string, number> = {};
  const frozen = Object.freeze({ ...scope });
  const p = new Proxy(frozen, {
    get(t, k) {
      if (typeof k === "string" && k in t) read[k] = t[k] as number;
      return Reflect.get(t, k) as unknown;
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("p", `"use strict";\n${code}`) as (p: unknown) => unknown;
  return { raw: fn(p), read };
}

export function toResult(
  raw: unknown,
  read: Record<string, number>,
): CheckResult | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "the check returned no object" };
  const r = raw as Record<string, unknown>;
  const value = Number(r.value);
  const limit = Number(r.limit);
  if (!Number.isFinite(value) || !Number.isFinite(limit) || typeof r.pass !== "boolean") {
    return { error: "the check must return finite value and limit and a boolean pass" };
  }
  return {
    pass: r.pass,
    value,
    limit,
    unit: typeof r.unit === "string" ? r.unit.slice(0, 24) : "",
    detail: typeof r.detail === "string" ? r.detail.slice(0, 300) : "",
    inputs: read,
  };
}
