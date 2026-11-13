import { createHash } from "node:crypto";

export const sha256 = (text: string | Buffer): string =>
  createHash("sha256").update(text).digest("hex");

// Sorted keys, no whitespace: the same value always hashes the same way.
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (value === undefined) return "null";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
