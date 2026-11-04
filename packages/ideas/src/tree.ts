// The idea tree as a hash-chained log. State is derived by replaying events;
// what the model returns is validated here before it becomes a node.

import { RECIPE_RELATIONS } from "@vibloom/chem";
import { canonical, sha256 } from "@vibloom/engine";
import { RECIPE_PARAMS, recipeDerived, runCheck, SIM_PARAMS, thresholds } from "./check";
import { numbersOf, unsupportedNumbers } from "./numbers";
import { bare, MAX_EXPR, names, OPS, rename, tokens, type Op } from "./expr";
import { AXES, type GrownNode } from "./protocol";
import type {
  CheckError,
  CheckResult,
  EventBody,
  IdeaEvent,
  IdeaNode,
  Lesson,
  Mode,
  Outcome,
  Prediction,
  Param,
  Refusal,
  Run,
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
  readonly lessons: Lesson[] = [];
  readonly predictions: Prediction[] = [];
  readonly runs: Run[] = [];
  // What the engine refused, in order; outside the hash chain on purpose.
  readonly refused: Refusal[] = [];
  // Visuals Muse designed for a node, latest last.
  readonly views = new Map<string, { title: string; html: string }>();
  // What Muse found when it looked at its latest drawing of a node.
  readonly reviews = new Map<string, { ok: boolean; problems: string[]; redrawn: boolean }>();
  // Nodes whose drawing was redrawn after a review found problems.
  readonly redrawn = new Set<string>();
  // The handwriting each handwritten formula was read from.
  readonly handwriting = new Map<string, string>();
  readonly chat: {
    focus: string;
    question: string;
    answer: string;
    cites: string[];
    asked: Record<string, number>;
    unsupported: string[];
  }[] = [];
  goal = "";
  mode: Mode = "standard";
  sketch: string | undefined;

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
      reviews: structuredClone(this.reviews),
      redrawn: new Set(this.redrawn),
      handwriting: new Map(this.handwriting),
      chat: this.chat.length,
      lessons: structuredClone(this.lessons),
      predictions: structuredClone(this.predictions),
      runs: structuredClone(this.runs),
      goal: this.goal,
      mode: this.mode,
    };
    try {
      this.apply(body);
    } catch (e) {
      this.refuse(actor, body.type, e instanceof Error ? e.message : String(e));
      this.nodes.clear();
      for (const [k, v] of before.nodes) this.nodes.set(k, v);
      this.results.clear();
      for (const [k, v] of before.results) this.results.set(k, v);
      this.views.clear();
      for (const [k, v] of before.views) this.views.set(k, v);
      this.reviews.clear();
      for (const [k, v] of before.reviews) this.reviews.set(k, v);
      this.redrawn.clear();
      for (const k of before.redrawn) this.redrawn.add(k);
      this.handwriting.clear();
      for (const [k, v] of before.handwriting) this.handwriting.set(k, v);
      this.chat.length = before.chat;
      this.lessons.splice(0, Infinity, ...before.lessons);
      this.predictions.splice(0, Infinity, ...before.predictions);
      this.runs.splice(0, Infinity, ...before.runs);
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
        if (b.sketch?.startsWith("data:image/jpeg;base64,") && b.sketch.length < 400_000) {
          this.sketch = b.sketch;
        }
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
          if (!sameRun(b.result.inputs ?? {}, this.scope(), "error" in b.result)) {
            throw new Error(`the run on ${b.node} is not for the current values`);
          }
          const seq = this.events.length;
          this.runs.push({
            seq,
            node: b.node,
            purpose: "check",
            result: structuredClone(b.result),
            state: "unconfirmed",
          });
          this.results.set(b.node, b.result);
          // A prediction is settled for good by the first run of its values.
          if (!("error" in b.result)) {
            for (const p of this.predictions) {
              if (p.node === b.node && p.run === undefined && sameRun(p.inputs, b.result.inputs))
                p.run = seq;
            }
          }
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
        if (this.reviews.get(b.node)?.ok === false) this.redrawn.add(b.node);
        this.reviews.delete(b.node);
        break;
      case "review":
        if (!this.views.has(b.node)) throw new Error(`no drawing on ${b.node}`);
        this.reviews.set(b.node, {
          ok: b.ok,
          problems: b.problems.slice(0, 3).map((x) => x.slice(0, 200)),
          redrawn: this.redrawn.has(b.node),
        });
        break;
      case "formula": {
        const n = this.nodes.get(b.node);
        if (!n || n.role === "goal") throw new Error(`unknown root ${b.node}`);
        if (n.check?.kind === "oregonator") throw new Error(`${b.node} is an experiment`);
        const c = b.check;
        if (
          !(OPS as readonly string[]).includes(c.op) ||
          !c.value.trim() ||
          !c.limit.trim() ||
          c.value.length > MAX_EXPR ||
          c.limit.length > MAX_EXPR
        ) {
          throw new Error("not a comparison VIBloom can compute");
        }
        const known = new Set(Object.keys(this.scope()));
        const missing = names(`${c.value} + ${c.limit}`).filter((x) => !known.has(x));
        if (missing.length) throw new Error(`no parameter named ${missing.join(", ")}`);
        n.check = {
          description: `Written by hand: ${b.reading}`.slice(0, 400),
          value: c.value,
          op: c.op as Op,
          limit: c.limit,
          unit: c.unit.slice(0, 24),
        };
        this.results.delete(b.node);
        if (b.image?.startsWith("data:image/jpeg;base64,") && b.image.length < 400_000) {
          this.handwriting.set(b.node, b.image);
        } else this.handwriting.delete(b.node);
        break;
      }
      case "chat":
        this.chat.push({
          focus: b.focus,
          question: b.question,
          answer: b.answer,
          cites: b.cites.filter((c) => this.nodes.has(c)),
          // Spread, so logs recorded before this field existed still replay.
          asked: { ...b.asked },
          unsupported: unsupportedNumbers(b.answer, this.shown(b.focus, b.question)),
        });
        break;
      case "predict": {
        const n = this.nodes.get(b.node);
        if (n?.check?.kind !== "oregonator") throw new Error(`no experiment on ${b.node}`);
        if (this.predictions.some((p) => p.id === b.id))
          throw new Error(`prediction ${b.id} exists`);
        // A prediction is about the values the tree has now, before their run.
        if (!sameRun(b.inputs, this.scope())) {
          throw new Error("a prediction is made for the current values");
        }
        this.predictions.push({
          id: b.id,
          node: b.node,
          inputs: pick(b.inputs),
          expect: b.expect,
          confidence: Math.min(0.99, Math.max(0.5, b.confidence)),
          reason: b.reason,
          uses: b.uses.filter((u) => this.lessons.some((l) => l.id === u && l.run !== undefined)),
          unsupported: unsupportedNumbers(
            b.reason,
            numbersOf([b.inputs, n.statement, n.check.tolerance, this.lessonsForModel(b.node)]),
          ),
        });
        break;
      }
      case "hypotheses": {
        // The chain: a prediction, the run that contradicted it, then two
        // explanations and their test, registered before the test runs.
        const p = this.predictions.find((x) => x.id === b.prediction);
        if (!p) throw new Error(`unknown prediction ${b.prediction}`);
        const first = this.runs.find((r) => r.seq === p.run);
        if (!first || "error" in first.result) {
          throw new Error(`prediction ${p.id} has no completed run`);
        }
        const observed: Outcome = first.result.pass ? "holds" : "fails";
        if (observed === p.expect) {
          throw new Error(`prediction ${p.id} was right; there is no surprise to explain`);
        }
        if (this.lessons.some((l) => l.id === b.id || l.prediction === p.id)) {
          throw new Error(`prediction ${p.id} already has explanations`);
        }
        const [a, c] = b.candidates;
        if (b.candidates.length !== 2 || !a || !c || a.expect === c.expect) {
          throw new Error("a lesson needs two explanations that expect different outcomes");
        }
        const now = this.scope();
        const recipe = RECIPE_PARAMS.every((k) => now[k] !== undefined)
          ? Object.fromEntries(RECIPE_PARAMS.map((k) => [k, now[k] ?? NaN]))
          : undefined;
        const onRecipe = (RECIPE_PARAMS as readonly string[]).includes(b.test.param);
        if (onRecipe && !recipe) throw new Error("there is no recipe to change");
        if (!onRecipe && !(SIM_PARAMS as readonly string[]).includes(b.test.param)) {
          throw new Error(
            `the test may change only ${[...SIM_PARAMS, ...(recipe ? RECIPE_PARAMS : [])].join(", ")}`,
          );
        }
        const before = onRecipe ? recipe?.[b.test.param] : p.inputs[b.test.param];
        if (!(b.test.value > 0) || before === undefined || b.test.value === before) {
          throw new Error("the test must change its parameter to a new positive value");
        }
        this.lessons.push({
          id: b.id,
          node: p.node,
          prediction: p.id,
          surprise: first.seq,
          basis: { ...p.inputs },
          observed,
          candidates: b.candidates.map((x) => ({ ...x })),
          test: { ...b.test },
          intervention: onRecipe ? "recipe" : "model",
          ...(recipe ? { recipe } : {}),
          open: b.open,
          unsupported: unsupportedNumbers(
            [...b.candidates.flatMap((x) => [x.explanation, x.scope]), b.open].join(" \n "),
            numbersOf([
              p.inputs,
              recipe,
              this.nodes.get(p.node)?.statement,
              this.nodes.get(p.node)?.check,
              p.confidence,
              first.result,
              b.test.value,
              this.lessonsForModel(p.node),
            ]),
          ),
        });
        break;
      }
      case "test": {
        const l = this.lessons.find((x) => x.id === b.hypotheses);
        if (!l) throw new Error(`unknown hypotheses ${b.hypotheses}`);
        if (l.run !== undefined) throw new Error(`${l.id} was already tested`);
        if (!sameRun(b.result.inputs ?? {}, this.testScope(l))) {
          throw new Error(`the run is not the test registered for ${l.id}`);
        }
        l.run = this.events.length;
        this.runs.push({
          seq: l.run,
          node: l.node,
          purpose: "test",
          result: structuredClone(b.result),
          state: "unconfirmed",
        });
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
      default:
        // A log from another version must not replay as if it said less.
        throw new Error(`unknown event ${String((b as { type: unknown }).type)}`);
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
    return { ...out, ...recipeDerived(out), ...this.outputs() };
  }

  // What the tree's recipe sets without any node owning it.
  derived(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const n of this.nodes.values()) for (const p of n.params) out[p.name] = p.value;
    return recipeDerived(out);
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
      const ts = r.inputs.time_scale_s;
      if (ts !== undefined) {
        if (r.sim.periods.full !== undefined) out[`${key}_period_full_s`] = r.sim.periods.full * ts;
        if (r.sim.periods.reduced !== undefined)
          out[`${key}_period_reduced_s`] = r.sim.periods.reduced * ts;
      }
    }
    return out;
  }

  // Experiments whose current result was read from a log and has not
  // reproduced in this browser (not yet, or not at all).
  get unconfirmed(): Set<string> {
    const out = new Set<string>();
    for (const id of this.results.keys()) {
      const r = this.latestRun(id);
      if (r && r.state !== "confirmed") out.add(id);
    }
    return out;
  }

  latestRun(node: string): Run | undefined {
    return this.runs.findLast((r) => r.node === node && r.purpose === "check");
  }

  // Runs a reader must re-run to trust what the tree shows: each experiment's
  // current result and every run a prediction or a lesson rests on.
  runsToConfirm(): Run[] {
    const needed = new Set<number>();
    for (const id of this.results.keys()) {
      const r = this.latestRun(id);
      if (r) needed.add(r.seq);
    }
    for (const p of this.predictions) if (p.run !== undefined) needed.add(p.run);
    for (const l of this.lessons) {
      needed.add(l.surprise);
      if (l.run !== undefined) needed.add(l.run);
    }
    return this.runs.filter((r) => r.state === "unconfirmed" && needed.has(r.seq));
  }

  private pendingOutputs(): Set<string> {
    const out = new Set<string>();
    for (const id of this.unconfirmed) {
      const key = outputKey(id);
      for (const m of ["full", "reduced"]) {
        out.add(`${key}_period_${m}`);
        out.add(`${key}_period_${m}_s`);
      }
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

  // The parameter, if any, that states the result a check claims and is only
  // assumed: declared by the model in observes, or named like an outcome
  // ("demonstrated_period"). A conclusion resting on it is conditional.
  assumedOutcome(id: string): string | undefined {
    const c = this.nodes.get(id)?.check;
    if (!c || c.kind === "oregonator") return undefined;
    const read = new Set([...safeNames(c.value), ...safeNames(c.limit)]);
    const claimed = [...(c.observes ?? []), ...[...read].filter((x) => OUTCOME.test(x))];
    return claimed.find((x) => read.has(x) && this.param(x)?.origin === "assumed");
  }

  // A check that computes nothing new: it restates an assumed number, or its
  // claimed result is itself assumed. It can argue, never hold or fail.
  circular(id: string): boolean {
    return this.restates(id) || this.assumedOutcome(id) !== undefined;
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
    // A run made under another version of the recipe conversion (or before
    // versions were recorded) is evidence about other numbers.
    const changed = (inputs?: Record<string, number>) =>
      Object.entries(inputs ?? {}).some(([k, v]) => !same(scope[k], v)) ||
      (inputs?.time_scale_s !== undefined && inputs.recipe_version !== scope.recipe_version);
    if (r && "error" in r) return changed(r.inputs) ? "stale" : "unverified";
    // Values that moved on make a run stale whether or not it reproduced.
    if (r && changed(r.inputs)) return "stale";
    if (this.unconfirmed.has(id)) return "unverified";
    // A verdict computed from a run not yet reproduced here is not a verdict yet.
    if (r && Object.keys(r.inputs).some((k) => this.pendingOutputs().has(k))) return "unverified";
    if (r && this.circular(id)) return ground === "broken" ? "affected" : "argued";
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

  refuse(actor: string, what: string, reason: string) {
    this.refused.push({ at: this.events.length, actor, what, reason: reason.slice(0, 300) });
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
    const given = new Map<string, string[]>();
    for (const g of grown.slice(0, 8)) {
      if (!isGrown(g)) {
        this.refuse("engine", "node", `a root Muse wrote did not follow the protocol: ${g.key}`);
        continue;
      }
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
      given.set(
        id,
        g.params.map((x) => x.name),
      );
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
      let observes = Array.isArray(c.observes) ? c.observes.filter(str).slice(0, 4) : [];
      for (const [from, to] of renamed) {
        c.value = rename(c.value, from, to);
        c.limit = rename(c.limit, from, to);
        observes = observes.map((x) => (x === from ? to : x));
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
                  ...(observes.length ? { observes } : {}),
                },
              }
            : {}),
        basis: g.basis,
        // Questioning a law of nature is always only a proposal.
        proposed: parent.role === "bedrock",
        expanded: false,
      });
    }
    // With a recipe in the tree, q, eps and eps_prime follow from it: a value
    // Muse also gave for them would silently replace the derivation, so it is
    // set aside and said so.
    const named = new Set([
      ...Object.keys(this.scope()),
      ...out.flatMap((n) => n.params.map((x) => x.name)),
    ]);
    if (RECIPE_PARAMS.every((k) => named.has(k))) {
      for (const n of out) {
        const drop = (given.get(n.id) ?? []).filter((x) => DERIVED.includes(x));
        if (!drop.length) continue;
        n.params = n.params.filter((x) => !DERIVED.includes(x.name));
        n.suggestions = n.suggestions.filter((x) => !DERIVED.includes(x.name));
        n.overridden = [...new Set(drop)];
        this.refuse(
          "engine",
          "parameter",
          `${n.overridden.join(", ")} on ${n.id}: the recipe sets ${n.overridden.length > 1 ? "them" : "it"}`,
        );
      }
    }
    // A formula that reads an experiment's output rests on that experiment.
    const byKey = new Map<string, string>();
    for (const n of [...this.nodes.values(), ...out]) byKey.set(outputKey(n.id), n.id);
    for (const n of out) {
      const c = n.check;
      if (!c || c.kind === "oregonator") continue;
      for (const name of [...safeNames(c.value), ...safeNames(c.limit)]) {
        const m = /^(.+)_period_(full|reduced)(_s)?$/.exec(name);
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

  // The browser re-ran a recorded experiment with the run's own inputs. The
  // recorded result stays what the log says; only its standing changes, so
  // every formula that read it still reproduces when the log is replayed.
  confirm(seq: number, again: CheckResult | CheckError) {
    const run = this.runs.find((r) => r.seq === seq);
    if (run?.state !== "unconfirmed") return;
    const r = run.result;
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
    run.state = same ? "confirmed" : "failed";
  }

  // What a run concluded, if it concluded and reproduced here.
  verdict(seq: number | undefined): Outcome | "pending" | "failed" | undefined {
    const run = this.runs.find((r) => r.seq === seq);
    if (!run) return undefined;
    if (run.state === "failed" || "error" in run.result) return "failed";
    if (run.state === "unconfirmed") return "pending";
    return run.result.pass ? "holds" : "fails";
  }

  // The values a lesson's test runs with, decided here and nowhere else. A
  // recipe change re-derives every model parameter from the changed recipe;
  // a model change moves one parameter and leaves the rest as they were.
  testScope(l: Lesson): Record<string, number> {
    if (l.intervention === "recipe" && l.recipe) {
      const recipe = { ...l.recipe, [l.test.param]: l.test.value };
      return { ...l.basis, ...recipe, ...recipeDerived(recipe) };
    }
    return { ...l.basis, [l.test.param]: l.test.value };
  }

  // The decided part of a lesson, derived from its runs, never from what the
  // model wrote: the test outcome and which explanation expected it.
  decided(l: Lesson): { outcome: Outcome; supported: number } | undefined {
    const v = this.verdict(l.run);
    if (v !== "holds" && v !== "fails") return undefined;
    return { outcome: v, supported: l.candidates.findIndex((c) => c.expect === v) };
  }

  // untested: explanations registered, test not run; unverified: a run it
  // rests on has not reproduced here yet; failed: one did not reproduce or
  // did not conclude; invalidated: a premise it was learned under changed.
  lessonState(l: Lesson): "untested" | "unverified" | "failed" | "invalidated" | "current" {
    if (l.run === undefined) return "untested";
    const runs = [this.verdict(l.surprise), this.verdict(l.run)];
    if (runs.includes("failed")) return "failed";
    if (runs.includes("pending")) return "unverified";
    const now = this.scope();
    return Object.entries(l.basis).every(([k, v]) => same(now[k], v)) ? "current" : "invalidated";
  }

  // What the model is shown of past lessons on a node: only decided ones.
  // The verified contrast comes straight from the recorded runs (values,
  // periods, measured difference, tolerance), apart from the interpretation
  // it was consistent with; binary leaves the numbers out, for comparison.
  // A lesson learned at other values is evidence, not a rule for this point.
  lessonsForModel(node: string, detail: "quantitative" | "binary" = "quantitative") {
    const now = this.scope();
    const spec = this.nodes.get(node)?.check;
    const tolerance = spec?.kind === "oregonator" ? spec.tolerance : undefined;
    const runOf = (seq: number | undefined) => {
      const r = this.runs.find((x) => x.seq === seq)?.result;
      if (!r || "error" in r) return undefined;
      return {
        values: pick(r.inputs),
        outcome: r.pass ? "holds" : "fails",
        ...(detail === "quantitative"
          ? {
              periods: { ...r.sim?.periods },
              relative_difference: r.value,
              run: seq,
            }
          : {}),
      };
    };
    return this.lessons
      .filter((l) => l.node === node)
      .flatMap((l) => {
        const d = this.decided(l);
        if (!d) return [];
        const here = SIM_PARAMS.every((k) => same(l.basis[k], now[k]));
        return [
          {
            id: l.id,
            applies_here: here
              ? "learned at exactly these values"
              : "learned at other values: evidence about those values; whether it carries over here is not checked",
            contrast: {
              ...(detail === "quantitative" && tolerance !== undefined
                ? { tolerance, difference: "|full - reduced| / reduced" }
                : {}),
              surprise: runOf(l.surprise),
              test: {
                changed: l.test.param,
                intervention:
                  l.intervention === "recipe"
                    ? "a recipe change: every model parameter followed it"
                    : "a model change: no recipe is shown to realize it",
                ...runOf(l.run),
              },
            },
            consistent_interpretation: l.candidates[d.supported]?.explanation ?? "",
            scope: l.candidates[d.supported]?.scope ?? "",
            contradicted: l.candidates
              .filter((_, i) => i !== d.supported)
              .map((c) => c.explanation),
            still_open: l.open,
          },
        ];
      });
  }

  // Every number Muse was shown when answering about a node: the tree's
  // values and results, where the focus check would flip, its lessons and the
  // question itself.
  private shown(focus: string, question: string): number[] {
    const n = this.nodes.get(focus);
    const r = this.results.get(focus);
    const flips =
      n?.check && n.check.kind !== "oregonator" && r && !("error" in r)
        ? thresholds(n.check, this.scope(), Object.keys(r.inputs))
        : [];
    return numbersOf([
      this.scope(),
      [...this.results.values()],
      flips,
      this.lessonsForModel(focus),
      [...this.nodes.values()].map((x) => [x.title, x.statement, x.rationale, x.check]),
      this.chat.slice(-4).map((c) => c.answer),
      Object.keys(this.derived()).length ? RECIPE_RELATIONS : "",
      question,
    ]);
  }

  // Each prediction against the run it was settled by, for good. Accuracy is
  // the share right; the Brier score (0 best, 0.25 a coin) also weighs the
  // stated confidence. Unreproduced runs are pending and not counted.
  calibration(): {
    made: number;
    right: number;
    surprises: number;
    pending: number;
    brier: number | undefined;
  } {
    let made = 0;
    let right = 0;
    let pending = 0;
    let sq = 0;
    for (const p of this.predictions) {
      const v = this.verdict(p.run);
      if (v === "pending") pending++;
      if (v !== "holds" && v !== "fails") continue;
      made++;
      if (v === p.expect) right++;
      const pHolds = p.expect === "holds" ? p.confidence : 1 - p.confidence;
      sq += (pHolds - (v === "holds" ? 1 : 0)) ** 2;
    }
    return { made, right, surprises: made - right, pending, brier: made ? sq / made : undefined };
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
        const ok =
          substitution(b.value, f.value) &&
          substitution(b.limit, f.limit) &&
          names(f.value + "+" + f.limit).every((x) => known.has(x));
        if (!ok) {
          this.refuse(
            "engine",
            "repair",
            `a repair of ${f.id} changed more than a misspelled name`,
          );
        }
        return ok;
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

const DERIVED = ["q", "eps", "eps_prime", "time_scale_s", "recipe_version"];

const OUTCOME =
  /(^|_)(achieved|demonstrated|measured|observed|actual|attained|obtained|realized|result|outcome)(_|$)/i;

const pick = (x: Record<string, number>) =>
  Object.fromEntries(SIM_PARAMS.map((k) => [k, x[k] ?? NaN]));

// Equal values, or the same derived value rounded differently: a recipe
// conversion rewritten with identical mathematics must not change history.
export function same(a: number | undefined, b: number | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b));
}

// Whether a run's inputs are the given values for every experiment parameter.
// A failed run may lack the inputs it never reached.
function sameRun(inputs: Record<string, number>, values: Record<string, number>, partial = false) {
  return SIM_PARAMS.every((k) => (inputs[k] === undefined ? partial : same(inputs[k], values[k])));
}

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
