// The idea tree as a hash-chained log. State is derived by replaying events;
// what the model returns is validated here before it becomes a node.

import { canonical, sha256 } from "@vibloom/engine";
import { runCheck } from "./check";
import { bare, MAX_EXPR, names, OPS, rename, tokens, type Op } from "./expr";
import { AXES, type GrownNode } from "./protocol";
import type {
  CheckError,
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
  | "unverified"
  | "partial";

export class IdeaTree {
  readonly events: IdeaEvent[] = [];
  readonly nodes = new Map<string, IdeaNode>();
  readonly results = new Map<string, CheckResult | CheckError>();
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
    return { ...out, ...this.outputs() };
  }

  // What confirmed experiments measured, readable by formulas as
  // <key>_period_full and <key>_period_reduced (key: the node's last id part),
  // so a claim about the period rests on the run, not on a restated number.
  outputs(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, r] of this.results) {
      // Unconfirmed runs still feed formulas, so a log reproduces; what reads
      // them stays unverified through its basis until they are confirmed.
      if ("error" in r || !r.sim) continue;
      const key = outputKey(id);
      if (r.sim.periods.full !== undefined) out[`${key}_period_full`] = r.sim.periods.full;
      if (r.sim.periods.reduced !== undefined) out[`${key}_period_reduced`] = r.sim.periods.reduced;
    }
    return out;
  }

  private pendingOutputs(): Set<string> {
    const out = new Set<string>();
    for (const id of this.unconfirmed) {
      const key = outputKey(id);
      out.add(`${key}_period_full`);
      out.add(`${key}_period_reduced`);
    }
    return out;
  }

  // A check that compares a number the node simply assumed against another
  // of its own numbers computes nothing (a stated "achieved 60 s" against a
  // target of 60 s): it can argue, never hold or fail.
  restates(id: string): boolean {
    const n = this.nodes.get(id);
    const c = n?.check;
    if (!n || !c || c.kind === "oregonator") return false;
    const a = bare(c.value);
    const b = bare(c.limit);
    if (a === undefined || b === undefined) return false;
    const own = (x: string) => n.params.find((p) => p.name === x);
    return own(a)?.origin === "assumed" && own(b) !== undefined;
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
    const scope = this.scope();
    const changed = (inputs?: Record<string, number>) =>
      Object.entries(inputs ?? {}).some(([k, v]) => scope[k] !== v);
    if (r && "error" in r) return changed(r.inputs) ? "stale" : "unverified";
    if (this.unconfirmed.has(id)) return "unverified";
    // A verdict computed from a run not yet reproduced here is not a verdict yet.
    if (r && Object.keys(r.inputs).some((k) => this.pendingOutputs().has(k))) return "unverified";
    if (r && this.restates(id)) return ground === "broken" ? "affected" : "argued";
    if (r) {
      if (changed(r.inputs)) return "stale";
      if (!r.pass) return "broken";
    }
    if (ground === "broken") return "affected";
    // A passing comparison is only as good as what it rests on: unconfirmed
    // premises make it unverified, merely argued ones make it partial.
    if (r) return ground === "unknown" ? "unverified" : ground === "partial" ? "partial" : "holds";
    if (n.role === "bedrock") return "bedrock";
    return n.risk === "high" ? "at_risk" : "argued";
  }

  // What a node rests on (its children and basis): broken if any premise is
  // broken, unknown if any could not be confirmed with current values,
  // partial if some are only argued.
  private premises(id: string, seen: Set<string>): "ok" | "partial" | "unknown" | "broken" {
    if (seen.has(id)) return "ok";
    seen.add(id);
    const n = this.nodes.get(id);
    let out: "ok" | "partial" | "unknown" | "broken" = "ok";
    for (const c of [...this.children(id).map((x) => x.id), ...(n?.basis ?? [])]) {
      const s = this.status(c, new Set(seen));
      if (s === "broken" || s === "affected") return "broken";
      if (s === "stale" || s === "unverified") out = "unknown";
      else if (out === "ok" && ["argued", "at_risk", "proposed", "partial"].includes(s))
        out = "partial";
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
      const renamed = new Map<string, string>();
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
          // This node's own formula meant its own quantity, in its own unit.
          renamed.set(p.name, alt);
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
      const c = { ...g.check };
      for (const [from, to] of renamed) {
        c.value = rename(c.value, from, to);
        c.limit = rename(c.limit, from, to);
      }
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
    // A formula that reads an experiment's output rests on that experiment.
    const byKey = new Map<string, string>();
    for (const n of [...this.nodes.values(), ...out]) byKey.set(outputKey(n.id), n.id);
    for (const n of out) {
      const c = n.check;
      if (!c || c.kind === "oregonator") continue;
      for (const name of [...safeNames(c.value), ...safeNames(c.limit)]) {
        const m = /^(.+)_period_(full|reduced)$/.exec(name);
        const target = m ? byKey.get(m[1] ?? "") : undefined;
        if (target && target !== n.id && !n.basis.includes(target)) n.basis.push(target);
      }
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
      a === b ||
      (a !== undefined && b !== undefined && Math.abs(a - b) <= EXPERIMENT_TOLERANCE * Math.abs(b));
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
    // A repair may only replace a misspelled name with a known one, token for
    // token: same operators, same sides, same constants, same structure.
    // Anything else would be a different question.
    const known = new Set(Object.keys(this.scope()));
    const substitution = (before: string, after: string) => {
      let a: string[];
      let b: string[];
      try {
        a = tokens(before);
        b = tokens(after);
      } catch {
        return false;
      }
      if (a.length !== b.length) return false;
      let changed = 0;
      for (let i = 0; i < a.length; i++) {
        const x = a[i] ?? "";
        const y = b[i] ?? "";
        if (x === y) continue;
        const wrong = x.startsWith("id:") && !known.has(x.slice(3));
        if (!wrong || !y.startsWith("id:") || !known.has(y.slice(3))) return false;
        changed++;
      }
      return changed >= 0;
    };
    return fixes
      .filter((f) => {
        const b = failing.get(f.id);
        if (!b || f.value.length > MAX_EXPR || f.limit.length > MAX_EXPR) return false;
        return (
          substitution(b.value, f.value) &&
          substitution(b.limit, f.limit) &&
          names(f.value + "+" + f.limit).every((x) => known.has(x))
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

// Periods measured by the same experiment in Node 22 and Chromium differed by
// up to 2.7e-6 relative (docs/validation.md); 1e-4 leaves a wide margin while
// staying far below any tolerance a claim uses. The verdict must match exactly.
export const EXPERIMENT_TOLERANCE = 1e-4;

export const outputKey = (id: string) => (id.split(".").at(-1) ?? id).replace(/-/g, "_");

function safeNames(src: string): string[] {
  try {
    return names(src);
  } catch {
    return [];
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
