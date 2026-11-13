// The `vibloom` command: the only part of the guard that touches the disk or
// runs processes.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { context } from "./context.ts";
import { derive, label, troubled, type NodeView } from "./derive.ts";
import { forgeFilters, parseForge, RunnerOutputError } from "./forge.ts";
import { sha256 } from "./hash.ts";
import { precommit } from "./gate.ts";
import { postTool, preTool, stop, type HookInput, type HookOutput } from "./hooks.ts";
import { extendsLog, nextEntry, readLog, type RunEntry } from "./log.ts";
import {
  DEFAULT_RUNNER,
  LOG_PATH,
  MAP_PATH,
  parseMap,
  serializeMap,
  watchedBy,
  type RootsMap,
} from "./map.ts";
import { addFound, findInvariants } from "./scan.ts";

const SKIP_DIRS = new Set([".git", "node_modules", "out", "cache", "broadcast"]);

export function findRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, MAP_PATH))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

export function loadMap(root: string): RootsMap {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, MAP_PATH), "utf8"));
  } catch (e) {
    throw new Error(`${MAP_PATH} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = parseMap(raw);
  if (!parsed.ok) throw new Error(`${MAP_PATH} has problems:\n- ${parsed.errors.join("\n- ")}`);
  return parsed.map;
}

export function loadLog(root: string): { entries: RunEntry[]; problems: string[] } {
  const p = join(root, LOG_PATH);
  return readLog(existsSync(p) ? readFileSync(p, "utf8") : "");
}

const toPosix = (p: string) => p.split(sep).join("/");

function walk(root: string, dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(join(root, dir));
  } catch {
    return;
  }
  for (const name of names.sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const rel = dir ? `${dir}/${name}` : name;
    const st = statSync(join(root, rel));
    if (st.isDirectory()) walk(root, rel, out);
    else if (st.isFile()) out.push(rel);
  }
}

// The hash of every file any node watches, as the tree is right now.
export function hashWatched(root: string, map: RootsMap): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const w of new Set(map.nodes.flatMap(watchedBy))) {
    const files: string[] = [];
    if (w.endsWith("/")) walk(root, w.slice(0, -1), files);
    else files.push(w);
    for (const f of files) {
      const p = join(root, f);
      out[f] = existsSync(p) && statSync(p).isFile() ? sha256(readFileSync(p)) : null;
    }
  }
  return out;
}

export function views(root: string): NodeView[] {
  const map = loadMap(root);
  return derive(map, loadLog(root).entries, hashWatched(root, map));
}

export interface RunReport {
  entry: RunEntry;
  views: NodeView[];
}

export function run(root: string, extra: readonly string[] = []): RunReport {
  const map = loadMap(root);
  const log = loadLog(root);
  if (log.problems.length) {
    throw new Error(`${LOG_PATH} failed verification:\n- ${log.problems.join("\n- ")}`);
  }
  // Hashed before the run: these are the files the tests ran against.
  const files = hashWatched(root, map);
  const [exe = "forge", ...args] = map.runner.length ? map.runner : DEFAULT_RUNNER;
  const command = [exe, ...args, ...extra];
  const res = spawnSync(exe, [...args, ...extra], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  let outcomes: ReturnType<typeof parseForge> = [];
  let error: string | undefined;
  if (res.error) error = `could not start ${exe}: ${res.error.message}`;
  else {
    try {
      outcomes = parseForge(res.stdout);
    } catch (e) {
      if (!(e instanceof RunnerOutputError)) throw e;
      const tail = (res.stderr || res.stdout).trim().split("\n").slice(-6).join("\n");
      error = `${e.message}${tail ? `\n${tail}` : ""}`;
    }
  }
  const body = { at: new Date().toISOString(), command, outcomes, files };
  const entry = nextEntry(log.entries.at(-1), error ? { ...body, error } : body);
  mkdirSync(join(root, ".vibloom"), { recursive: true });
  appendFileSync(join(root, LOG_PATH), `${JSON.stringify(entry)}\n`);
  return { entry, views: derive(map, [...log.entries, entry], hashWatched(root, map)) };
}

function table(vs: readonly NodeView[]): string {
  if (!vs.length)
    return "The map has no nodes yet. Run `vibloom scan` or edit .vibloom/roots.json.";
  const w = Math.max(...vs.map((v) => label(v).length));
  const iw = Math.max(...vs.map((v) => v.id.length));
  return vs.map((v) => `${label(v).padEnd(w)}  ${v.id.padEnd(iw)}  ${v.title}`).join("\n");
}

export const HOOKS_CONFIG = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash",
        hooks: [{ type: "command", command: "vibloom hook pre-tool" }],
      },
    ],
    PostToolUse: [
      {
        matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash",
        hooks: [{ type: "command", command: "vibloom hook post-tool" }],
      },
    ],
    Stop: [{ hooks: [{ type: "command", command: "vibloom hook stop" }] }],
  },
};

function hook(kind: string, stdin: string, env: NodeJS.ProcessEnv): HookOutput {
  let input: HookInput = {};
  try {
    input = JSON.parse(stdin || "{}") as HookInput;
  } catch {
    return { exit: 0, stderr: "VIBloom: the hook input was not JSON; nothing checked." };
  }
  const root = findRoot(input.cwd ?? process.cwd());
  if (!root) return { exit: 0 };
  const rel = (p: string): string | undefined => {
    const r = relative(root, isAbsolute(p) ? p : resolve(input.cwd ?? root, p));
    return r.startsWith("..") || isAbsolute(r) ? undefined : toPosix(r);
  };
  let map: RootsMap;
  try {
    map = loadMap(root);
  } catch (e) {
    return { exit: 0, stderr: e instanceof Error ? e.message : String(e) };
  }
  const role = env.VIBLOOM_ROLE === "verifier" ? "verifier" : "builder";
  if (kind === "pre-tool") return preTool(input, map, role, rel);
  if (kind === "post-tool") {
    // After a test run, the guard re-runs the same subset with --json and
    // records it; the agent's own output is never parsed or trusted.
    const filters =
      input.tool_name === "Bash" ? forgeFilters(input.tool_input?.command ?? "") : undefined;
    return postTool(input, filters ? run(root, filters).views : views(root), rel);
  }
  if (kind === "stop") return stop(input, views(root), loadLog(root).problems);
  return { exit: 0, stderr: `VIBloom: unknown hook ${kind}` };
}

const USAGE = `vibloom: assumptions, invariants and intentions for a code project.

  vibloom init               create .vibloom/roots.json and list the invariant tests found
  vibloom scan               add invariant tests the map does not list yet
  vibloom status             the derived state of every node (exit 1 if any needs attention)
  vibloom run [-- args]      run the tests, record the run, show what changed
  vibloom check [--base ref] [-- args]
                             run, then exit 1 if any node needs attention (for CI); with
                             --base, first require the log to extend the one on that commit
  vibloom context [file]     what an agent should know before touching a file
  vibloom verify             check the run log's hash chain
  vibloom precommit          refuse a commit that changes guarded files or leaves a node
                             broken or untested since its files changed (any agent, any editor)

Optional, for Claude Code:
  vibloom hooks              print the hooks configuration for .claude/settings.json
  vibloom hook <event>       called by those hooks: pre-tool, post-tool or stop

Set VIBLOOM_ROLE=verifier for the one agent or person allowed to change
protected tests and the map.`;

export interface Io {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: () => string;
  out: (s: string) => void;
  err: (s: string) => void;
}

export function main(argv: readonly string[], io: Io): number {
  const [cmd, ...rest] = argv;
  // Our options come first; anything else, or anything after "--", goes to the runner.
  let base: string | undefined;
  const extra: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a === "--") {
      extra.push(...rest.slice(i + 1));
      break;
    }
    if (a === "--base" && cmd === "check") base = rest[++i];
    else extra.push(a);
  }
  try {
    if (!cmd || cmd === "help" || cmd === "--help") {
      io.out(USAGE);
      return cmd ? 0 : 1;
    }
    if (cmd === "hook") {
      const r = hook(rest[0] ?? "", io.stdin(), io.env);
      if (r.stdout) io.out(r.stdout);
      if (r.stderr) io.err(r.stderr);
      return r.exit;
    }
    if (cmd === "hooks") {
      io.out(JSON.stringify(HOOKS_CONFIG, null, 2));
      return 0;
    }
    if (cmd === "init") {
      if (findRoot(io.cwd) === resolve(io.cwd)) {
        io.err(`${MAP_PATH} already exists here.`);
        return 1;
      }
      mkdirSync(join(io.cwd, ".vibloom"), { recursive: true });
      const empty: RootsMap = {
        version: 1,
        runner: DEFAULT_RUNNER,
        tests: "test/",
        protect: [],
        nodes: [],
      };
      const { map, added } = scan(io.cwd, empty);
      writeFileSync(join(io.cwd, MAP_PATH), serializeMap(map));
      io.out(`Created ${MAP_PATH} with ${String(added.length)} invariant tests found.`);
      io.out(
        "Give them titles, add assumptions and intentions, then add `vibloom hooks` to .claude/settings.json.",
      );
      return 0;
    }
    const root = findRoot(io.cwd);
    if (!root) {
      io.err(`No ${MAP_PATH} here or above. Run \`vibloom init\` at the project root.`);
      return 1;
    }
    if (cmd === "scan") {
      const { map, added } = scan(root, loadMap(root));
      if (added.length) writeFileSync(join(root, MAP_PATH), serializeMap(map));
      io.out(added.length ? `Added ${added.join(", ")}.` : "No new invariant tests.");
      return 0;
    }
    if (cmd === "status") {
      const vs = views(root);
      const { problems } = loadLog(root);
      if (problems.length)
        io.err(
          `The run log failed verification; only runs before the break count:\n- ${problems.join("\n- ")}`,
        );
      io.out(table(vs));
      return vs.some(troubled) || problems.length ? 1 : 0;
    }
    if (cmd === "check" && base !== undefined) {
      const problems = checkBase(root, base);
      if (problems.length) {
        io.err(
          `VIBloom: the run log does not extend the one on ${base}:\n- ${problems.join("\n- ")}`,
        );
        return 1;
      }
    }
    if (cmd === "run" || cmd === "check") {
      const before = new Map(views(root).map((v) => [v.id, label(v)]));
      const { entry, views: vs } = run(root, extra);
      if (entry.error) io.err(`Run ${String(entry.seq)} recorded with an error: ${entry.error}`);
      const moved = vs.filter((v) => before.get(v.id) !== label(v));
      io.out(`Run ${String(entry.seq)}: ${String(entry.outcomes.length)} test results recorded.`);
      if (moved.length)
        io.out(
          `Changed:\n${moved.map((v) => `  ${v.id}: ${before.get(v.id) ?? "new"} -> ${label(v)}`).join("\n")}`,
        );
      io.out(table(vs));
      return cmd === "check" && (vs.some(troubled) || !!entry.error) ? 1 : 0;
    }
    if (cmd === "context") {
      io.out(
        context(
          views(root),
          rest[0] ? toPosix(relative(root, resolve(io.cwd, rest[0]))) : undefined,
        ),
      );
      return 0;
    }
    if (cmd === "precommit") {
      const git = spawnSync("git", ["diff", "--cached", "--name-only", "-z"], {
        cwd: root,
        encoding: "utf8",
      });
      if (git.status !== 0) {
        io.err(`git diff --cached failed: ${git.stderr.trim()}`);
        return 1;
      }
      const staged = git.stdout.split("\0").filter(Boolean);
      const role = io.env.VIBLOOM_ROLE === "verifier" ? "verifier" : "builder";
      const r = precommit(loadMap(root), views(root), staged, role, loadLog(root).problems);
      if (r.ok) return 0;
      io.err(`VIBloom refused the commit:\n- ${r.problems.join("\n- ")}`);
      io.err("Run `vibloom run` after changing code; only the verifier changes protected tests.");
      return 1;
    }
    if (cmd === "verify") {
      const { entries, problems } = loadLog(root);
      if (problems.length) {
        io.err(problems.join("\n"));
        return 1;
      }
      io.out(`${String(entries.length)} runs, chain intact.`);
      return 0;
    }
    io.err(`Unknown command ${cmd}.\n\n${USAGE}`);
    return 1;
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

// The log on the base commit, read from git rather than the working tree, so
// a branch cannot change what it is compared against.
function checkBase(root: string, ref: string): string[] {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).status !== 0) {
    return [`${ref} is not a commit here (in CI, fetch the base branch first)`];
  }
  const shown = git("show", `${ref}:./${LOG_PATH}`);
  const base = readLog(shown.status === 0 ? shown.stdout : "");
  if (base.problems.length) return base.problems.map((p) => `base log: ${p}`);
  const head = loadLog(root);
  if (head.problems.length) return head.problems;
  return extendsLog(base.entries, head.entries);
}

function scan(root: string, map: RootsMap): ReturnType<typeof addFound> {
  const files: string[] = [];
  walk(root, map.tests.replace(/\/$/, ""), files);
  const found = files
    .filter((f) => f.endsWith(".t.sol"))
    .flatMap((f) => findInvariants(f, readFileSync(join(root, f), "utf8")));
  return addFound(map, found);
}
