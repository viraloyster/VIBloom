// The record of every run, one JSON line each, chained by hash: an entry cannot
// be changed or removed without breaking every hash after it.

import type { Outcome } from "./forge.ts";
import { canonical, sha256 } from "./hash.ts";

export const GENESIS = "genesis";

export interface RunEntry {
  seq: number;
  at: string;
  prev: string;
  command: string[];
  outcomes: Outcome[];
  // Hash of every watched file when the run started; null when it did not exist.
  files: Record<string, string | null>;
  error?: string;
  hash: string;
}

export type RunBody = Omit<RunEntry, "seq" | "prev" | "hash">;

export const entryHash = (e: Omit<RunEntry, "hash">): string => sha256(canonical(e));

export function nextEntry(last: RunEntry | undefined, body: RunBody): RunEntry {
  const base = { ...body, seq: (last?.seq ?? 0) + 1, prev: last?.hash ?? GENESIS };
  return { ...base, hash: entryHash(base) };
}

export interface ReadLog {
  entries: RunEntry[];
  problems: string[];
}

// Entries up to the first broken link; anything after it is not trusted.
export function readLog(text: string): ReadLog {
  const entries: RunEntry[] = [];
  const problems: string[] = [];
  const lines = text.split("\n").filter((l) => l.trim());
  for (const [i, line] of lines.entries()) {
    let e: RunEntry;
    try {
      e = JSON.parse(line) as RunEntry;
    } catch {
      problems.push(`line ${String(i + 1)} is not JSON`);
      break;
    }
    const last = entries.at(-1);
    const { hash, ...rest } = e;
    if (e.prev !== (last?.hash ?? GENESIS) || e.seq !== (last?.seq ?? 0) + 1) {
      problems.push(`entry ${String(e.seq)} does not follow entry ${String(last?.seq ?? 0)}`);
      break;
    }
    if (entryHash(rest) !== hash) {
      problems.push(`entry ${String(e.seq)} was changed after it was written`);
      break;
    }
    entries.push(e);
  }
  const ignored = lines.length - entries.length - 1;
  if (problems.length && ignored > 0) {
    problems.push(`${String(ignored)} ${ignored === 1 ? "entry" : "entries"} after it ignored`);
  }
  return { entries, problems };
}
