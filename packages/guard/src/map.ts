// The roots of a code project: what it assumes, what must always hold, and what
// each change intends. People and verifier agents write this file; the guard
// only reads it.

export type Kind = "assumption" | "invariant" | "intention";
export type Stance = "adopted" | "hypothetical" | "off";

export interface TestRef {
  file: string;
  contract?: string;
  name: string;
}

export interface RootNode {
  id: string;
  kind: Kind;
  title: string;
  detail?: string;
  stance: Stance;
  test?: TestRef;
  // Files or directories (ending in "/") whose change puts the node's evidence
  // up for review.
  watch: string[];
  dependsOn: string[];
  // A protected node's test may only be edited by the verifier role.
  protected: boolean;
}

export interface RootsMap {
  version: 1;
  runner: string[];
  tests: string;
  // Paths only the verifier may edit, besides protected tests and .vibloom/.
  protect: string[];
  nodes: RootNode[];
}

export const MAP_PATH = ".vibloom/roots.json";
export const LOG_PATH = ".vibloom/log.jsonl";
export const DEFAULT_RUNNER = ["forge", "test", "--json"];

const ID = /^[a-z0-9][a-z0-9._-]*$/;
const KINDS: readonly Kind[] = ["assumption", "invariant", "intention"];
const STANCES: readonly Stance[] = ["adopted", "hypothetical", "off"];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

// A repository-relative path that cannot climb out of the repository.
export const safePath = (p: string): boolean =>
  p.length > 0 && !p.startsWith("/") && !p.split("/").includes("..") && !p.includes("\\");

export type Parsed = { ok: true; map: RootsMap } | { ok: false; errors: string[] };

export function parseMap(raw: unknown): Parsed {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["the map must be a JSON object"] };
  if (raw.version !== 1) errors.push("version must be 1");
  const runner = raw.runner ?? DEFAULT_RUNNER;
  if (!strings(runner) || runner.length === 0)
    errors.push("runner must be a non-empty string list");
  const tests = raw.tests ?? "test/";
  if (typeof tests !== "string" || !safePath(tests)) errors.push("tests must be a relative path");
  const protect = raw.protect ?? [];
  if (!strings(protect) || !protect.every(safePath))
    errors.push("protect must list relative paths");
  if (!Array.isArray(raw.nodes)) errors.push("nodes must be a list");

  const nodes: RootNode[] = [];
  const seen = new Set<string>();
  for (const [i, n] of (Array.isArray(raw.nodes) ? raw.nodes : []).entries()) {
    const at = `nodes[${String(i)}]`;
    if (!isRecord(n)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const id = n.id;
    if (typeof id !== "string" || !ID.test(id)) {
      errors.push(`${at}.id must match ${String(ID)}`);
      continue;
    }
    if (seen.has(id)) errors.push(`${id}: duplicate id`);
    seen.add(id);
    const kind = n.kind;
    if (typeof kind !== "string" || !KINDS.includes(kind as Kind)) {
      errors.push(`${id}: kind must be one of ${KINDS.join(", ")}`);
      continue;
    }
    if (typeof n.title !== "string" || !n.title.trim()) errors.push(`${id}: title is required`);
    if (n.detail !== undefined && typeof n.detail !== "string")
      errors.push(`${id}: detail must be text`);
    const stance = n.stance ?? (kind === "assumption" ? "hypothetical" : "adopted");
    if (typeof stance !== "string" || !STANCES.includes(stance as Stance)) {
      errors.push(`${id}: stance must be one of ${STANCES.join(", ")}`);
    }
    const watch = n.watch ?? [];
    if (!strings(watch) || !watch.every(safePath))
      errors.push(`${id}: watch must list relative paths`);
    const dependsOn = n.depends_on ?? [];
    if (!strings(dependsOn)) errors.push(`${id}: depends_on must list ids`);
    let test: TestRef | undefined;
    if (n.test !== undefined) {
      const t = n.test;
      if (
        !isRecord(t) ||
        typeof t.file !== "string" ||
        !safePath(t.file) ||
        typeof t.name !== "string" ||
        (t.contract !== undefined && typeof t.contract !== "string")
      ) {
        errors.push(`${id}: test needs a relative file and a name`);
      } else {
        test = { file: t.file, name: t.name.replace(/\(.*$/, "") };
        if (typeof t.contract === "string") test.contract = t.contract;
      }
    }
    if (kind === "invariant" && !test) errors.push(`${id}: an invariant needs a test`);
    const node: RootNode = {
      id,
      kind: kind as Kind,
      title: typeof n.title === "string" ? n.title : "",
      stance: stance as Stance,
      watch: strings(watch) ? watch : [],
      dependsOn: strings(dependsOn) ? dependsOn : [],
      protected: n.protected === undefined ? kind === "invariant" : n.protected === true,
    };
    if (typeof n.detail === "string") node.detail = n.detail;
    if (test) node.test = test;
    nodes.push(node);
  }

  for (const n of nodes) {
    for (const d of n.dependsOn) {
      if (!seen.has(d)) errors.push(`${n.id}: depends on unknown ${d}`);
      if (d === n.id) errors.push(`${n.id}: depends on itself`);
    }
  }
  const cycle = findCycle(nodes);
  if (cycle) errors.push(`dependency cycle: ${cycle.join(" -> ")}`);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    map: {
      version: 1,
      runner: runner as string[],
      tests: tests as string,
      protect: protect as string[],
      nodes,
    },
  };
}

function findCycle(nodes: RootNode[]): string[] | undefined {
  const deps = new Map(nodes.map((n) => [n.id, n.dependsOn]));
  const state = new Map<string, "open" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === "done") return undefined;
    if (state.get(id) === "open") return [...path.slice(path.indexOf(id)), id];
    state.set(id, "open");
    path.push(id);
    for (const d of deps.get(id) ?? []) {
      const c = visit(d);
      if (c) return c;
    }
    path.pop();
    state.set(id, "done");
    return undefined;
  };
  for (const n of nodes) {
    const c = visit(n.id);
    if (c) return c;
  }
  return undefined;
}

// The map as written to disk: snake_case keys, defaults left out.
export function serializeMap(map: RootsMap): string {
  const nodes = map.nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    title: n.title,
    ...(n.detail ? { detail: n.detail } : {}),
    stance: n.stance,
    ...(n.test ? { test: n.test } : {}),
    ...(n.watch.length ? { watch: n.watch } : {}),
    ...(n.dependsOn.length ? { depends_on: n.dependsOn } : {}),
    protected: n.protected,
  }));
  return `${JSON.stringify(
    { version: 1, runner: map.runner, tests: map.tests, protect: map.protect, nodes },
    null,
    2,
  )}\n`;
}

// Every path a node's evidence depends on: what it watches and its test file.
export const watchedBy = (n: RootNode): string[] =>
  n.test && !n.watch.includes(n.test.file) ? [...n.watch, n.test.file] : n.watch;

export const covers = (watch: string, file: string): boolean =>
  watch.endsWith("/") ? file.startsWith(watch) : file === watch;
