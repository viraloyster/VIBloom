// One project behind the API. The server decides who acts: people send
// commands as "human", runs are recorded as "engine", and nothing in a request
// body can choose its own actor.

import { evaluatePoint, type InitialCondition } from "@vibloom/chem";
import type { Claim, ExperimentNode, ResultRecord, RootNode } from "@vibloom/contracts";
import {
  basisFor,
  canonical,
  claimView,
  Project,
  resultView,
  sha256,
  type Event,
  type Submission,
} from "@vibloom/engine";
import { CONTRACT, SEED_OPS } from "./seed";

export interface EventStore {
  all(): Event[];
  append(event: Event): void;
}

export type Clock = () => string;

export interface RunRequest {
  experiment: string;
  point: Record<string, number>;
  ic?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export class ProjectService {
  private readonly store: EventStore;
  private readonly clock: Clock;
  private project: Project;

  constructor(store: EventStore, clock: Clock = () => new Date().toISOString()) {
    this.store = store;
    this.clock = clock;
    const replayed = Project.replay(CONTRACT, store.all());
    if (!replayed.ok) throw new Error(`stored log fails replay at ${String(replayed.seq)}`);
    this.project = replayed.project;
  }

  private commit(input: unknown): Submission {
    const r = this.project.submit(input, this.clock());
    if (r.ok && !r.duplicate) this.store.append(r.event);
    return r;
  }

  seed(): Submission {
    return this.commit({
      commandId: "seed",
      actor: "human",
      approved: true,
      baseHead: this.project.head,
      ops: SEED_OPS,
    });
  }

  // A person's command. Only actor and approval are taken from the server.
  command(body: unknown, approvedByPerson: boolean): Submission {
    if (!isObj(body)) return { ok: false, code: "invalid_input", detail: "$: must be an object" };
    const { commandId, baseHead, ops } = body;
    return this.commit({ commandId, baseHead, ops, actor: "human", approved: approvedByPerson });
  }

  run(body: unknown): Submission {
    if (!isObj(body) || typeof body.experiment !== "string" || !isObj(body.point)) {
      return { ok: false, code: "invalid_input", detail: "needs experiment and point" };
    }
    const state = this.project.state;
    const exp = state.nodes.get(body.experiment);
    if (exp?.kind !== "experiment") {
      return { ok: false, code: "not_found", detail: "unknown experiment" };
    }
    const claimNode = state.nodes.get(exp.spec.claim.id);
    const model = state.nodes.get(exp.spec.model.id);
    if (claimNode?.kind !== "claim" || model?.kind !== "model") {
      return { ok: false, code: "not_found", detail: "experiment spec is incomplete" };
    }
    const claim = claimNode.predicate;
    const point = this.pointFor(claim, body.point);
    if (typeof point === "string") return { ok: false, code: "invalid_input", detail: point };
    const ic = typeof body.ic === "string" ? body.ic : claim.ic;
    if (!CONTRACT.initialConditions.includes(ic)) {
      return { ok: false, code: "invalid_input", detail: "unknown initial condition" };
    }

    // The basis is captured before the run, so later changes make it stale.
    const assumptionIds = [...state.nodes.values()]
      .filter((n) => n.kind === "assumption")
      .map((n) => n.id);
    const basis = basisFor(state, exp.id, []);
    const assumptions = basis.filter((b) => assumptionIds.includes(b.id));
    const { q = NaN, eps = NaN } = model.params;
    const evaluation = evaluatePoint(claim, { q, eps }, point, ic as InitialCondition);

    const id = `r-${sha256(canonical({ exp: exp.id, point, ic, basis, head: state.head })).slice(0, 16)}`;
    const record: ResultRecord = {
      id,
      experiment: { id: exp.id, revision: exp.revision },
      claim: { id: claimNode.id, revision: claimNode.revision },
      assumptions,
      basis,
      execution: evaluation.execution,
      point,
    };
    const full = evaluation.runs.full;
    const reduced = evaluation.runs.reduced;
    const observed = full ?? reduced;
    if (observed) record.observation = observed.observation;
    if (evaluation.outcome) {
      record.outcome = evaluation.outcome;
      if (claim.kind === "FOR_ALL" && evaluation.outcome === "fails") {
        record.region = {
          status: "counterexample_found",
          counterexamples: 1,
          evaluated: 1,
          inconclusive: 0,
        };
      } else if (claim.kind === "FOR_ALL" && evaluation.outcome === "holds") {
        record.region = { status: "no_counterexample", evaluated: 1, inconclusive: 0 };
      }
    }
    const violated = this.violation(evaluation.execution, state.nodes.values());
    if (violated) record.violated = violated;

    return this.commit({
      commandId: id,
      actor: "engine",
      baseHead: state.head,
      ops: [{ op: "record_result", result: record }],
    });
  }

  // Region claims take a point inside the region plus their fixed values.
  private pointFor(claim: Claim, given: Record<string, unknown>): Record<string, number> | string {
    const point: Record<string, number> = {};
    for (const [k, v] of Object.entries(given)) {
      const d = CONTRACT.domain[k];
      if (!d) return `parameter ${k} is not in the contract`;
      if (typeof v !== "number" || !Number.isFinite(v)) return `${k} must be a finite number`;
      if (v < d.min || v > d.max) return `${k} is outside the admissible domain`;
      point[k] = v;
    }
    if (claim.kind === "FOR_ALL") {
      for (const [k, r] of Object.entries(claim.region)) {
        const v = point[k];
        if (v === undefined || v < r.min || v > r.max) return `${k} must lie in the claim region`;
      }
      for (const [k, v] of Object.entries(claim.fixed)) {
        if (k in point && point[k] !== v) return `${k} is fixed by the claim`;
        point[k] = v;
      }
    }
    if (point.s === undefined || point.eps_prime === undefined)
      return "the point must set s and eps_prime";
    return point;
  }

  private violation(
    execution: ResultRecord["execution"],
    nodes: Iterable<RootNode>,
  ): ResultRecord["violated"] {
    if (execution.status !== "failed" || execution.reason !== "domain_exit") return undefined;
    for (const n of nodes) {
      if (n.kind === "invariant" && n.check === "non_negative_state") {
        return {
          invariant: { id: n.id, revision: n.revision },
          detail: "a concentration left the domain",
        };
      }
    }
    return undefined;
  }

  view() {
    const s = this.project.state;
    return {
      head: s.head,
      lastHash: s.lastHash,
      nodes: [...s.nodes.values()],
      edges: s.edges,
      results: [...s.results.values()].map((record) => ({ record, view: resultView(s, record) })),
      claims: [...s.nodes.values()]
        .filter((n) => n.kind === "claim")
        .map((n) => claimView(s, n.id)),
      experiments: [...s.nodes.values()].filter(
        (n): n is ExperimentNode => n.kind === "experiment",
      ),
    };
  }

  events(): Event[] {
    return this.project.events;
  }

  // Replays the stored log from scratch and compares it with the live head.
  verify() {
    const r = Project.replay(CONTRACT, this.store.all());
    if (!r.ok) return { ok: false as const, seq: r.seq, detail: r.detail };
    const head = r.project.state.lastHash;
    return { ok: head === this.project.state.lastHash, head, events: r.project.head };
  }
}
