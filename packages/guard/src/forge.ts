// Reads `forge test --json`: one entry per suite ("path:Contract"), one result
// per test. Only status and reason are kept; traces stay with Foundry.

export type OutcomeStatus = "pass" | "fail" | "skip";

export interface Outcome {
  file: string;
  contract: string;
  name: string;
  status: OutcomeStatus;
  reason?: string;
}

export class RunnerOutputError extends Error {}

const STATUS: Record<string, OutcomeStatus> = {
  Success: "pass",
  Failure: "fail",
  Skipped: "skip",
};

export function parseForge(stdout: string): Outcome[] {
  // Foundry may print notices before the JSON; the report is the last line
  // that opens an object.
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .at(-1);
  if (!line) throw new RunnerOutputError("the runner printed no JSON report");
  let report: unknown;
  try {
    report = JSON.parse(line);
  } catch {
    throw new RunnerOutputError("the runner's JSON report could not be parsed");
  }
  if (typeof report !== "object" || report === null) {
    throw new RunnerOutputError("the runner's report is not an object");
  }
  const out: Outcome[] = [];
  for (const [suite, body] of Object.entries(report as Record<string, unknown>)) {
    const cut = suite.lastIndexOf(":");
    if (cut < 0) continue;
    const results = (body as { test_results?: unknown } | null)?.test_results;
    if (typeof results !== "object" || results === null) continue;
    for (const [sig, r] of Object.entries(results as Record<string, unknown>)) {
      const res = r as { status?: unknown; reason?: unknown } | null;
      const status = typeof res?.status === "string" ? STATUS[res.status] : undefined;
      if (!status) continue;
      const o: Outcome = {
        file: suite.slice(0, cut),
        contract: suite.slice(cut + 1),
        name: sig.replace(/\(.*$/, ""),
        status,
      };
      if (typeof res?.reason === "string" && res.reason) o.reason = res.reason.slice(0, 500);
      out.push(o);
    }
  }
  return out;
}

// The test filters of a `forge test` command line, to re-run the same subset.
export function forgeFilters(command: string): string[] | undefined {
  if (!/\bforge\s+test\b/.test(command)) return undefined;
  const flags = new Set([
    "--match-path",
    "--mp",
    "--match-test",
    "--mt",
    "--match-contract",
    "--mc",
    "--no-match-path",
    "--nmp",
    "--no-match-test",
    "--nmt",
    "--no-match-contract",
    "--nmc",
  ]);
  const words = command.slice(command.search(/\bforge\s+test\b/)).split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? "";
    if (/[;&|]/.test(w)) break;
    const eq = w.indexOf("=");
    const flag = eq > 0 ? w.slice(0, eq) : w;
    if (!flags.has(flag)) continue;
    const value = eq > 0 ? w.slice(eq + 1) : words[++i];
    if (value) out.push(flag, value.replace(/^["']|["']$/g, ""));
  }
  return out;
}
