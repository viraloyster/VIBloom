// The idea tree as a hash-chained log. State is derived by replaying events;
// what the model returns is validated here before it becomes a node.

import { canonical, sha256 } from "@vibloom/engine";
import { AXES, type GrownNode } from "./protocol";
import type { CheckResult, EventBody, IdeaEvent, IdeaNode, Mode, Param, Usage } from "./types";

const GENESIS = "0".repeat(64);
const MAX_CODE = 4000;

export type Status =
  | "goal"
  | "holds"
  | "broken"
  | "affected"
  | "stale"
  | "at_risk"
  | "argued"
  | "bedrock"
  | "proposed";

export class IdeaTree {
  readonly events: IdeaEvent[] = [];
  readonly nodes = new Map<string, IdeaNode>();
  readonly results = new Map<string, CheckResult | { error: string }>();
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

  append(actor: string, body: EventBody): IdeaEvent {
    this.apply(body);
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
          basis: [],
          proposed: false,
          expanded: false,
        });
        break;
      case "grow": {
        const under = this.nodes.get(b.under);
        if (!under) throw new Error(`unknown node ${b.under}`);
        // Copies, so later edits never alter the recorded event.
        for (const n of b.nodes) this.nodes.set(n.id, structuredClone(n));
        under.expanded = true;
        break;
      }
      case "check":
        if (!this.nodes.has(b.node)) throw new Error(`unknown node ${b.node}`);
        this.results.set(b.node, b.result);
        break;
      case "repair":
        for (const f of b.fixes) {
          const n = this.nodes.get(f.node);
          if (!n?.check) throw new Error(`no check on ${f.node}`);
          n.check = { ...n.check, code: f.code };
          this.results.delete(f.node);
        }
        break;
      case "set_param": {
        const p = this.nodes.get(b.node)?.params.find((x) => x.name === b.name);
        if (!p || !Number.isFinite(b.value)) throw new Error(`no param ${b.name} on ${b.node}`);
        p.value = b.value;
        p.origin = "assumed";
        p.source = "set by a person";
        break;
      }
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

  // Parameters a check may read: its own, its ancestors' and its basis nodes'.
  // The nearest definition of a name wins.
  scope(id: string): Record<string, number> {
    const n = this.nodes.get(id);
    if (!n) return {};
    const from = [...this.ancestors(id)].reverse();
    for (const b of n.basis) {
      const x = this.nodes.get(b);
      if (x) from.push(x);
    }
    from.push(n);
    const out: Record<string, number> = {};
    for (const x of from) for (const p of x.params) out[p.name] = p.value;
    return out;
  }

  // Assumed numbers the node's check relies on.
  assumedInputs(id: string): Param[] {
    const r = this.results.get(id);
    if (!r || "error" in r) return [];
    const all = [this.nodes.get(id), ...this.ancestors(id)].flatMap((n) => n?.params ?? []);
    return all.filter((p) => p.origin === "assumed" && p.name in r.inputs);
  }

  status(id: string, seen = new Set<string>()): Status {
    const n = this.nodes.get(id);
    if (!n) return "argued";
    if (n.role === "goal") return this.premisesBroken(id, seen) ? "affected" : "goal";
    if (n.proposed) return "proposed";
    const r = this.results.get(id);
    if (r && !("error" in r)) {
      const scope = this.scope(id);
      if (Object.entries(r.inputs).some(([k, v]) => scope[k] !== v)) return "stale";
      if (!r.pass) return "broken";
    }
    if (this.premisesBroken(id, seen)) return "affected";
    if (r && !("error" in r)) return "holds";
    if (n.role === "bedrock") return "bedrock";
    return n.risk === "high" ? "at_risk" : "argued";
  }

  // A node rests on its children and its basis; if any of them is broken, so
  // is the ground under it.
  private premisesBroken(id: string, seen: Set<string>): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    const n = this.nodes.get(id);
    const under = [...this.children(id).map((c) => c.id), ...(n?.basis ?? [])];
    return under.some((c) => {
      const s = this.status(c, seen);
      return s === "broken" || s === "affected";
    });
  }

  // How much rests on a node: everything above it and everything that cites it.
  weight(id: string): number {
    const up = new Set(this.ancestors(id).map((n) => n.id));
    for (const n of this.nodes.values()) if (n.basis.includes(id)) up.add(n.id);
    return up.size;
  }

  // Turn what the model returned into nodes, refusing anything off-protocol.
  admit(under: string, grown: GrownNode[]): IdeaNode[] {
    const parent = this.nodes.get(under);
    if (!parent) throw new Error(`unknown node ${under}`);
    const keys = new Map<string, string>();
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
        params: g.params
          .filter((p) => p.name && Number.isFinite(p.value))
          .slice(0, 12)
          .map((p) => ({
            name: p.name.replace(/\W+/g, "_").slice(0, 64),
            value: p.value,
            unit: p.unit.slice(0, 24),
            origin: p.origin === "reference" ? "reference" : "assumed",
            source: p.origin === "reference" ? p.source.slice(0, 200) : "",
          })),
        ...(g.check.code.trim() && g.check.code.length <= MAX_CODE
          ? { check: { description: g.check.description.slice(0, 400), code: g.check.code } }
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

  // Checks that failed to run, with what a repair needs to see.
  broken(): { id: string; code: string; error: string; params: string[] }[] {
    const out = [];
    for (const [id, r] of this.results) {
      const n = this.nodes.get(id);
      if (n?.check && "error" in r) {
        out.push({ id, code: n.check.code, error: r.error, params: Object.keys(this.scope(id)) });
      }
    }
    return out;
  }

  // Admits only fixes for checks that are failing, within the size limit.
  admitFixes(fixes: { id: string; code: string }[]): { node: string; code: string }[] {
    const failing = new Set(this.broken().map((b) => b.id));
    return fixes
      .filter((f) => failing.has(f.id) && f.code.trim() && f.code.length <= MAX_CODE)
      .map((f) => ({ node: f.id, code: f.code }));
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
    str(g.check.code) &&
    str(g.check.description) &&
    Array.isArray(g.basis) &&
    g.basis.every(str)
  );
}

export type { Usage };
