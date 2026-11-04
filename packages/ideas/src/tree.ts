// The idea tree as a hash-chained log. State is derived by replaying events;
// what the model returns is validated here before it becomes a node.

import { canonical, sha256 } from "@vibloom/engine";
import { runCheck } from "./check";
import { MAX_EXPR, names, OPS, type Op } from "./expr";
import { AXES, type GrownNode } from "./protocol";
import type {
  CheckResult,
  EventBody,
  IdeaEvent,
  IdeaNode,
  Mode,
  Param,
  SimQuestion,
  Usage,
} from "./types";

const GENESIS = "0".repeat(64);

export type Status =
  | "goal"
  | "holds"
  | "broken"
  | "affected"
  | "stale"
  | "at_risk"
  | "argued"
  | "bedrock"
  | "proposed"
  | "unverified";

export class IdeaTree {
  readonly events: IdeaEvent[] = [];
  readonly nodes = new Map<string, IdeaNode>();
  readonly results = new Map<string, CheckResult | { error: string }>();
  // Experiment results read from a log and not yet re-run in this browser.
  readonly unconfirmed = new Set<string>();
  // Visuals Muse designed for a node, latest last.
  readonly views = new Map<string, { title: string; html: string }>();
  readonly chat: {
    focus: string;
    question: string;
    answer: string;
    cites: string[];
    asked: Record<string, number>;
  }[] = [];
  goal = "";
  mode: Mode = "standard";

  get head() {
    return this.events.at(-1)?.hash ?? GENESIS;
  }

  static replay(events: IdeaEvent[]): IdeaTree {
    const t = new IdeaTree();
    for (const e of events) {
      if (e.prev !== t.head || e.seq !== t.events.length)
        throw new Error(`broken chain at ${String(e.seq)}`);
      if (e.hash !== hashOf(e.seq, e.prev, e.actor, e.body))
        throw new Error(`bad hash at ${String(e.seq)}`);
      t.apply(e.body);
      t.events.push(e);
    }
    return t;
  }

  // All or nothing: a body that fails half way leaves the tree as it was.
  append(actor: string, body: EventBody): IdeaEvent {
    const before = {
      nodes: structuredClone(this.nodes),
      results: structuredClone(this.results),
      views: structuredClone(this.views),
      chat: this.chat.length,
      goal: this.goal,
      mode: this.mode,
    };
    try {
      this.apply(body);
    } catch (e) {
      this.nodes.clear();
      for (const [k, v] of before.nodes) this.nodes.set(k, v);
      this.results.clear();
      for (const [k, v] of before.results) this.results.set(k, v);
      this.views.clear();
      for (const [k, v] of before.views) this.views.set(k, v);
      this.chat.length = before.chat;
      this.goal = before.goal;
      this.mode = before.mode;
      throw e;
    }
    const seq = this.events.length;
    const prev = this.head;
    const e = { seq, prev, actor, body, hash: hashOf(seq, prev, actor, body) };
    this.events.push(e);
    return e;
  }

  private apply(b: EventBody) {
    switch (b.type) {
      case "goal":
        if (this.events.length > 0) throw new Error("the goal is set once");
        this.goal = b.text;
        this.mode = b.mode;
        this.nodes.set("goal", {
          id: "goal",
          parent: null,
          title: b.text,
          statement: b.text,
          axis: "requirements",
          role: "goal",
          criticality: "critical",
          risk: "medium",
          rationale: "",
          params: [],
          uses: [],
          suggestions: [],
          basis: [],
          proposed: false,
          expanded: false,
        });
        break;
      case "grow": {
        const under = this.nodes.get(b.under);
        if (!under) throw new Error(`unknown node ${b.under}`);
        // Copies, so later edits never alter the recorded event.
        for (const n of b.nodes) {
          for (const p of n.params) {
            if (this.owner(p.name)) throw new Error(`parameter ${p.name} already exists`);
          }
          this.nodes.set(n.id, structuredClone(n));
        }
        under.expanded = true;
        break;
      }
      case "check": {
        const spec = this.nodes.get(b.node)?.check;
        if (!spec) throw new Error(`no check on ${b.node}`);
        // An experiment takes seconds, so it is not re-run inside the log;
        // its result counts only once the browser has run it again (confirm).
        if (spec.kind === "oregonator") {
          this.results.set(b.node, b.result);
          this.unconfirmed.add(b.node);
          break;
        }
        // A recorded result is accepted only if the engine reaches the same
        // one now, from the same formula and values.
        const again = runCheck(spec, this.scope());
        const same =
          "error" in again
            ? "error" in b.result
            : !("error" in b.result) &&
              again.pass === b.result.pass &&
              again.value === b.result.value &&
              again.limit === b.result.limit;
        if (!same) throw new Error(`check on ${b.node} does not reproduce`);
        this.results.set(b.node, again);
        break;
      }
      case "repair":
        for (const f of b.fixes) {
          const n = this.nodes.get(f.node);
          if (!n?.check || n.check.kind === "oregonator")
            throw new Error(`no formula on ${f.node}`);
          n.check = { ...n.check, value: f.value, limit: f.limit };
          this.results.delete(f.node);
        }
        break;
      case "set_param": {
        const p = this.owner(b.name)?.params.find((x) => x.name === b.name);
        if (!p || !Number.isFinite(b.value)) throw new Error(`no parameter ${b.name}`);
        p.value = b.value;
        p.origin = "assumed";
        p.source = b.source;
        break;
      }
      case "view":
        if (!this.nodes.has(b.node)) throw new Error(`unknown node ${b.node}`);
        this.views.set(b.node, { title: b.title, html: b.html });
        break;
      case "chat":
        this.chat.push({
          focus: b.focus,
          question: b.question,
          answer: b.answer,
          cites: b.cites.filter((c) => this.nodes.has(c)),
          // Spread, so logs recorded before this field existed still replay.
          asked: { ...b.asked },
        });
        break;
      case "accept":
      case "reject": {
        const n = this.nodes.get(b.node);
        if (!n?.proposed) throw new Error(`${b.node} is not a proposal`);
        if (b.type === "accept") n.proposed = false;
        else this.remove(n.id);
        break;
      }
    }
  }

  private remove(id: string) {
    for (const c of this.children(id)) this.remove(c.id);
    this.nodes.delete(id);
    this.results.delete(id);
  }

  children(id: string): IdeaNode[] {
    return [...this.nodes.values()].filter((n) => n.parent === id);
  }

  ancestors(id: string): IdeaNode[] {
    const out: IdeaNode[] = [];
    let n = this.nodes.get(this.nodes.get(id)?.parent ?? "");
    while (n) {
      out.push(n);
      n = this.nodes.get(n.parent ?? "");
    }
    return out;
  }

  // The node that introduced a parameter. Each name has exactly one.
  owner(name: string): IdeaNode | undefined {
    for (const n of this.nodes.values()) if (n.params.some((p) => p.name === name)) return n;
    return undefined;
  }

  param(name: string): Param | undefined {
    return this.owner(name)?.params.find((p) => p.name === name);
  }

  // Every parameter in the tree, one value per name, so a change anywhere
  // reaches every check that reads it.
  scope(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const n of this.nodes.values()) for (const p of n.params) out[p.name] = p.value;
    return out;
  }

  // Assumed numbers the node's check relies on.
  assumedInputs(id: string): Param[] {
    const r = this.results.get(id);
    if (!r || "error" in r) return [];
    return Object.keys(r.inputs)
      .map((k) => this.param(k))
      .filter((p): p is Param => p?.origin === "assumed");
  }

  status(id: string, seen = new Set<string>()): Status {
    const n = this.nodes.get(id);
    if (!n) return "argued";
    const ground = this.premises(id, seen);
    if (n.role === "goal")
      return ground === "broken" ? "affected" : ground === "unknown" ? "unverified" : "goal";
    if (n.proposed) return "proposed";
    const r = this.results.get(id);
    if (r && "error" in r) return "unverified";
    if (this.unconfirmed.has(id)) return "unverified";
    if (r) {
      const scope = this.scope();
      if (Object.entries(r.inputs).some(([k, v]) => scope[k] !== v)) return "stale";
      if (!r.pass) return "broken";
    }
    if (ground === "broken") return "affected";
    // A green check is only as good as what it rests on.
    if (r) return ground === "unknown" ? "unverified" : "holds";
    if (n.role === "bedrock") return "bedrock";
    return n.risk === "high" ? "at_risk" : "argued";
  }

  // What a node rests on (its children and basis): broken if any premise is
  // broken, unknown if any could not be confirmed with current values.
  private premises(id: string, seen: Set<string>): "ok" | "unknown" | "broken" {
    if (seen.has(id)) return "ok";
    seen.add(id);
    const n = this.nodes.get(id);
    let out: "ok" | "unknown" | "broken" = "ok";
    for (const c of [...this.children(id).map((x) => x.id), ...(n?.basis ?? [])]) {
      const s = this.status(c, new Set(seen));
      if (s === "broken" || s === "affected") return "broken";
      if (s === "stale" || s === "unverified") out = "unknown";
    }
    return out;
  }

  // How much rests on a node: everything above it and everything that cites it.
  weight(id: string): number {
    const up = new Set(this.ancestors(id).map((n) => n.id));
    for (const n of this.nodes.values()) if (n.basis.includes(id)) up.add(n.id);
    return up.size;
  }

  // Turn what the model returned into nodes, refusing anything off-protocol.
  // A parameter that already exists is never copied: the node uses it, and a
  // different value becomes a suggestion for a person to adopt.
  admit(under: string, grown: GrownNode[]): IdeaNode[] {
    const parent = this.nodes.get(under);
    if (!parent) throw new Error(`unknown node ${under}`);
    const keys = new Map<string, string>();
    const taken = new Set(Object.keys(this.scope()));
    const out: IdeaNode[] = [];
    for (const g of grown.slice(0, 8)) {
      if (!isGrown(g)) continue;
      const slug =
        g.key
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "n";
      let id = under === "goal" ? slug : `${under}.${slug}`;
      while (this.nodes.has(id) || keys.has(id)) id += "x";
      keys.set(g.key, id);
      const params: Param[] = [];
      const uses: string[] = [];
      const suggestions: Param[] = [];
      for (const raw of g.params.slice(0, 12)) {
        if (!raw.name || !Number.isFinite(raw.value)) continue;
        const p: Param = {
          name: raw.name.replace(/\W+/g, "_").slice(0, 64),
          kind: raw.kind === "requirement" || raw.kind === "design" ? raw.kind : "external",
          value: raw.value,
          unit: raw.unit.slice(0, 24),
          origin: raw.origin === "reference" ? "reference" : "assumed",
          source: raw.origin === "reference" ? raw.source.slice(0, 200) : "",
        };
        // The same name in another unit is a different quantity, not a share.
        const existing =
          this.param(p.name) ?? out.flatMap((o) => o.params).find((x) => x.name === p.name);
        if (existing && existing.unit.trim().toLowerCase() !== p.unit.trim().toLowerCase()) {
          let alt = `${p.name}_${p.unit.replace(/\W+/g, "_").toLowerCase()}`.slice(0, 64);
          while (taken.has(alt)) alt += "_";
          p.name = alt;
        }
        if (!taken.has(p.name)) {
          taken.add(p.name);
          params.push(p);
          continue;
        }
        if (!uses.includes(p.name)) uses.push(p.name);
        const current =
          this.param(p.name) ?? out.flatMap((o) => o.params).find((x) => x.name === p.name);
        if (
          current &&
          Math.abs(current.value - p.value) > 1e-9 * Math.max(1, Math.abs(current.value))
        ) {
          suggestions.push(p);
        }
      }
      const c = g.check;
      const question = c.question ?? "";
      const tolerance = c.tolerance ?? NaN;
      const experiment =
        c.kind === "oregonator" &&
        ["oscillates", "reduced_oscillates", "reduction_keeps_period"].includes(question) &&
        tolerance > 0 &&
        tolerance < 1;
      const computable =
        c.kind !== "oregonator" &&
        (OPS as readonly string[]).includes(c.op) &&
        c.value.trim() !== "" &&
        c.limit.trim() !== "" &&
        c.value.length <= MAX_EXPR &&
        c.limit.length <= MAX_EXPR;
      out.push({
        id,
        parent: under,
        title: g.title.slice(0, 120),
        statement: g.statement.slice(0, 600),
        axis: g.axis,
        role: g.role,
        criticality: g.criticality,
        risk: g.risk,
        rationale: g.rationale.slice(0, 600),
        params,
        uses,
        suggestions,
        ...(experiment
          ? {
              check: {
                kind: "oregonator" as const,
                description: c.description.slice(0, 400),
                question: question as SimQuestion,
                tolerance,
                op: "<=" as const,
                unit: "" as const,
              },
            }
          : computable
            ? {
                check: {
                  description: c.description.slice(0, 400),
                  value: c.value,
                  op: c.op as Op,
                  limit: c.limit,
                  unit: c.unit.slice(0, 24),
                },
              }
            : {}),
        basis: g.basis,
        // Questioning a law of nature is always only a proposal.
        proposed: parent.role === "bedrock",
        expanded: false,
      });
    }
    // Basis may name siblings by key or existing nodes by id; anything else
    // is dropped.
    for (const n of out) {
      n.basis = n.basis
        .map((b) => keys.get(b) ?? b)
        .filter((b) => b !== n.id && (this.nodes.has(b) || out.some((o) => o.id === b)));
    }
    return out;
  }

  // The browser re-ran an experiment: it counts only if it reproduces.
  confirm(id: string, again: CheckResult | { error: string }) {
    const r = this.results.get(id);
    if (!r || !this.unconfirmed.has(id)) return;
    this.unconfirmed.delete(id);
    const close = (a?: number, b?: number) =>
      a === b || (a !== undefined && b !== undefined && Math.abs(a - b) <= 1e-6 * Math.abs(b));
    const same =
      "error" in again
        ? "error" in r
        : !("error" in r) &&
          again.pass === r.pass &&
          close(again.sim?.periods.full, r.sim?.periods.full) &&
          close(again.sim?.periods.reduced, r.sim?.periods.reduced);
    this.results.set(
      id,
      same ? again : { error: "the recorded experiment did not reproduce here" },
    );
  }

  // Whether values an answer relied on have changed since it was given.
  outdated(i: number): boolean {
    const c = this.chat[i];
    if (!c) return false;
    const now = this.scope();
    return Object.entries(c.asked).some(([k, v]) => k in now && now[k] !== v);
  }

  // Checks that failed to evaluate, with what a repair needs to see.
  broken(): { id: string; value: string; limit: string; error: string; params: string[] }[] {
    const out = [];
    const names = Object.keys(this.scope());
    for (const [id, r] of this.results) {
      const n = this.nodes.get(id);
      if (n?.check && n.check.kind !== "oregonator" && "error" in r) {
        out.push({ id, value: n.check.value, limit: n.check.limit, error: r.error, params: names });
      }
    }
    return out;
  }

  // Admits only fixes for checks that are failing, within the size limit.
  admitFixes(
    fixes: { id: string; value: string; limit: string }[],
  ): { node: string; value: string; limit: string }[] {
    const failing = new Map(this.broken().map((b) => [b.id, b]));
    // A repair fixes syntax only: every known quantity the original read is
    // still read, nothing new is added except in place of a misspelled name,
    // and every constant stays the same. Anything else is a different question.
    const known = new Set(Object.keys(this.scope()));
    const ids = (src: string) => src.replace(/\bp\./g, "").match(/[A-Za-z_]\w*/g) ?? [];
    const nums = (src: string) => (src.match(/\d+\.?\d*(e[+-]?\d+)?/gi) ?? []).sort().join();
    const parses = (src: string) => {
      try {
        names(src);
        return true;
      } catch {
        return false;
      }
    };
    return fixes
      .filter((f) => {
        const b = failing.get(f.id);
        if (!b || f.value.length > MAX_EXPR || f.limit.length > MAX_EXPR) return false;
        if (!parses(f.value) || !parses(f.limit)) return false;
        const before = [...ids(b.value), ...ids(b.limit)];
        const after = [...names(f.value), ...names(f.limit)];
        const kept = before.filter((x) => known.has(x));
        const unknownBefore = new Set(before.filter((x) => !known.has(x))).size;
        const added = after.filter((x) => !kept.includes(x));
        return (
          after.length > 0 &&
          after.every((x) => known.has(x)) &&
          kept.every((x) => after.includes(x)) &&
          new Set(added).size <= unknownBefore &&
          nums(b.value + " " + b.limit) === nums(f.value + " " + f.limit)
        );
      })
      .map((f) => ({ node: f.id, value: f.value, limit: f.limit }));
  }

  // What the model sees when it expands a node: the path from the goal, the
  // node itself and a one-line index of everything else, so it reuses nodes.
  context(id: string): string {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown node ${id}`);
    const line = (x: IdeaNode) => `${x.id} | ${x.title}`;
    return JSON.stringify({
      goal: this.goal,
      path: this.ancestors(id)
        .reverse()
        .map((x) => ({ id: x.id, statement: x.statement, params: x.params })),
      node: {
        id: n.id,
        statement: n.statement,
        role: n.role,
        params: n.params,
        rationale: n.rationale,
      },
      existing: [...this.nodes.values()].filter((x) => x.id !== id).map(line),
      params: [...this.nodes.values()].flatMap((x) =>
        x.params.map((p) => `${p.name} = ${String(p.value)} ${p.unit}`),
      ),
    });
  }
}

function hashOf(seq: number, prev: string, actor: string, body: EventBody): string {
  return sha256(canonical({ seq, prev, actor, body }));
}

const str = (x: unknown): x is string => typeof x === "string";

function isGrown(g: GrownNode): boolean {
  return (
    str(g.key) &&
    str(g.title) &&
    str(g.statement) &&
    (AXES as readonly string[]).includes(g.axis) &&
    ["assumption", "bedrock"].includes(g.role) &&
    ["critical", "major", "minor"].includes(g.criticality) &&
    ["low", "medium", "high"].includes(g.risk) &&
    str(g.rationale) &&
    Array.isArray(g.params) &&
    typeof g.check === "object" &&
    str(g.check.value) &&
    str(g.check.limit) &&
    str(g.check.op) &&
    str(g.check.unit) &&
    str(g.check.description) &&
    Array.isArray(g.basis) &&
    g.basis.every(str)
  );
}

export type { Usage };
