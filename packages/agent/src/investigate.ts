// The investigation loop. The model decides what to formulate, which
// experiment to run and what it expects; the code checks every decision,
// runs it through the gate and scores each prediction against the result.

import {
  parseDecision,
  type Decision,
  type PointOutcome,
  type ResultRecord,
} from "@vibloom/contracts";
import {
  canonical,
  claimView,
  resultView,
  type Op,
  type Rejection,
  type State,
  type Submission,
} from "@vibloom/engine";
import { renderContext } from "./context";

export type Effort = "low" | "medium";

export interface Workspace {
  state(): State;
  // The implementation submits these as the "agent" actor.
  submitAsAgent(ops: Op[]): Submission;
  runPoint(request: {
    experiment: string;
    point: Record<string, number>;
    ic?: string;
  }): { ok: true; result: ResultRecord } | Rejection;
}

export interface TurnRequest {
  goal: string;
  turn: number;
  effort: Effort;
  context: string;
  trace: TraceEntry[];
  // Why the previous attempt was rejected, so the model can correct it.
  feedback?: string;
}

export interface TurnReply {
  decision: unknown;
  usage?: { input: number; output: number; reasoning?: number };
}

export interface Provider {
  readonly name: string;
  decide(request: TurnRequest): Promise<TurnReply>;
}

export type PredictionVerdict = "as_predicted" | "surprise" | "undetermined";

export interface TraceEntry {
  turn: number;
  call: number;
  effort: Effort;
  decision?: Decision;
  accepted: boolean;
  rejection?: string;
  head: number;
  result?: string;
  prediction?: {
    predicted: "holds" | "fails";
    observed?: PointOutcome;
    verdict: PredictionVerdict;
  };
  usage?: TurnReply["usage"];
}

export type Stop = "concluded" | "asked_researcher" | "budget_exhausted" | "provider_failed";

export interface Investigation {
  goal: string;
  provider: string;
  stop: Stop;
  trace: TraceEntry[];
  // Set when the model could not be reached; what was done so far is kept.
  error?: string;
}

export const BUDGET = { turns: 8, calls: 14, escalations: 1 } as const;

class DecisionError extends Error {}
const refuse = (detail: string): never => {
  throw new DecisionError(detail);
};

function scorePrediction(predicted: "holds" | "fails", observed?: PointOutcome): PredictionVerdict {
  if (observed !== "holds" && observed !== "fails") return "undetermined";
  return observed === predicted ? "as_predicted" : "surprise";
}

function checkCites(s: State, d: Decision) {
  for (const id of d.cites) {
    if (!s.nodes.has(id) && !s.results.has(id)) refuse(`cites ${id}, which is not in the project`);
  }
}

function soleModel(s: State) {
  const models = [...s.nodes.values()].filter((n) => n.kind === "model");
  const [model] = models;
  if (models.length !== 1 || !model) {
    return refuse("the project needs exactly one model to attach experiments to");
  }
  return model;
}

const experimentFor = (claim: string) => `${claim}-runs`;

function formulateOps(s: State, d: Extract<Decision, { action: "formulate" }>): Op[] {
  const model = soleModel(s);
  const ops: Op[] = [];
  for (const a of d.assumptions) {
    ops.push({
      op: "add_node",
      node: { kind: "assumption", ...a, state: "hypothetical", protected: false },
    });
  }
  for (const c of d.claims) {
    ops.push(
      {
        op: "add_node",
        node: {
          kind: "claim",
          id: c.id,
          title: c.title,
          version: 1,
          text: c.text,
          predicate: c.predicate as never,
          protocol: "robust-v1",
        },
      },
      {
        op: "add_node",
        node: {
          kind: "experiment",
          id: experimentFor(c.id),
          title: `Point runs for ${c.id}`,
          spec: {
            model: { id: model.id, revision: model.revision },
            claim: { id: c.id, revision: 1 },
            solver: "seulex-v1",
            detector: "peaks-v1",
            protocol: "robust-v1",
          },
          results: [],
        },
      },
    );
  }
  for (const dep of d.dependencies) {
    ops.push({
      op: "add_edge",
      edge: { from: dep.from, to: dep.to, origin: "model", state: "hypothetical" },
    });
  }
  return ops;
}

function reviseOps(s: State, d: Extract<Decision, { action: "revise" }>): Op[] {
  const prev = s.nodes.get(d.previous.id);
  if (prev?.kind !== "claim") return refuse(`${d.previous.id} is not a claim`);
  const model = soleModel(s);
  return [
    {
      op: "add_node",
      node: {
        kind: "claim",
        id: d.claim.id,
        title: d.claim.title,
        version: prev.version + 1,
        text: d.claim.text,
        predicate: d.claim.predicate as never,
        protocol: prev.protocol,
        supersedes: d.previous,
      },
    },
    {
      op: "add_node",
      node: {
        kind: "experiment",
        id: experimentFor(d.claim.id),
        title: `Point runs for ${d.claim.id}`,
        spec: {
          model: { id: model.id, revision: model.revision },
          claim: { id: d.claim.id, revision: 1 },
          solver: "seulex-v1",
          detector: "peaks-v1",
          protocol: prev.protocol,
        },
        results: [],
      },
    },
  ];
}

// The verdict, the results and their currency are checked; the
// interpretation stays the model's reading.
function checkConclusion(s: State, d: Extract<Decision, { action: "conclude" }>) {
  const view = claimView(s, d.claim);
  if (!view) return refuse(`${d.claim} is not a claim`);
  if (view.verdict.verdict !== d.verdict) {
    refuse(`the engine derives ${view.verdict.verdict} for ${d.claim}, not ${d.verdict}`);
  }
  if (d.results.length === 0) refuse("a conclusion must rest on at least one result");
  for (const id of d.results) {
    const r = s.results.get(id);
    if (r?.claim.id !== d.claim) refuse(`${id} is not a result of ${d.claim}`);
    else if (resultView(s, r).currency !== "current") refuse(`${id} is no longer current`);
  }
  if (
    "by" in view.verdict &&
    !d.results.some((id) => (view.verdict as { by: string[] }).by.includes(id))
  ) {
    refuse("the results must include the evidence the verdict rests on");
  }
}

// The point as the engine stores it: claim fixed values filled, keys sorted.
function effectivePoint(s: State, claimId: string, point: Record<string, number>): string {
  const c = s.nodes.get(claimId);
  const fixed = c?.kind === "claim" && c.predicate.kind === "FOR_ALL" ? c.predicate.fixed : {};
  return canonical({ ...point, ...fixed });
}

// Points already used on earlier versions of a claim cannot test a new
// version. Initial conditions need no check: a claim is only tested under its own.
function usedPoints(s: State, claimId: string): string[] {
  const used: string[] = [];
  let node = s.nodes.get(claimId);
  while (node?.kind === "claim" && node.supersedes) {
    const prevId = node.supersedes.id;
    for (const r of s.results.values()) {
      if (r.claim.id === prevId && r.point) used.push(canonical(r.point));
    }
    node = s.nodes.get(prevId);
  }
  return used;
}

export async function investigate(
  goal: string,
  provider: Provider,
  workspace: Workspace,
): Promise<Investigation> {
  const trace: TraceEntry[] = [];
  let effort: Effort = "low";
  let escalations = 0;
  let feedback: string | undefined;
  let pendingSurprise = false;
  let turn = 1;

  for (let call = 1; call <= BUDGET.calls && turn <= BUDGET.turns; call++) {
    const state = workspace.state();
    const request: TurnRequest = {
      goal,
      turn,
      effort,
      context: renderContext(state),
      trace: structuredClone(trace),
    };
    if (feedback !== undefined) request.feedback = feedback;
    let reply: TurnReply;
    try {
      reply = await provider.decide(request);
    } catch (e) {
      const error = e instanceof Error ? e.message : "unknown provider error";
      return { goal, provider: provider.name, stop: "provider_failed", trace, error };
    }
    const entry: TraceEntry = { turn, call, effort, accepted: false, head: state.head };
    if (reply.usage) entry.usage = reply.usage;
    trace.push(entry);

    const parsed = parseDecision(reply.decision);
    if (!parsed.ok) {
      entry.rejection = feedback = parsed.detail;
      continue;
    }
    const d = parsed.decision;
    entry.decision = d;

    try {
      checkCites(state, d);
      if (pendingSurprise && d.surprise === undefined) {
        refuse("the last prediction failed; explain the surprise before moving on");
      }
      if (d.escalate !== undefined && escalations >= BUDGET.escalations) {
        refuse("reasoning effort can be raised only once per investigation");
      }

      switch (d.action) {
        case "formulate":
        case "revise": {
          const ops = d.action === "formulate" ? formulateOps(state, d) : reviseOps(state, d);
          const r = workspace.submitAsAgent(ops);
          if (!r.ok) refuse(`${r.code}: ${r.detail}`);
          break;
        }
        case "run_point": {
          const exp = state.nodes.get(d.experiment);
          if (exp?.kind === "experiment") {
            const key = effectivePoint(state, exp.spec.claim.id, d.point);
            if (usedPoints(state, exp.spec.claim.id).includes(key)) {
              refuse("a new claim version must be tested on fresh points");
            }
          }
          const request = {
            experiment: d.experiment,
            point: d.point,
            ...(d.ic ? { ic: d.ic } : {}),
          };
          const r = workspace.runPoint(request);
          if (!r.ok) refuse(`${r.code}: ${r.detail}`);
          else {
            const verdict = scorePrediction(d.prediction.outcome, r.result.outcome);
            entry.result = r.result.id;
            entry.prediction = { predicted: d.prediction.outcome, verdict };
            if (r.result.outcome) entry.prediction.observed = r.result.outcome;
            pendingSurprise = verdict === "surprise";
          }
          break;
        }
        case "conclude":
          checkConclusion(state, d);
          break;
        case "ask_researcher":
          break;
      }
    } catch (e) {
      if (!(e instanceof DecisionError)) throw e;
      entry.rejection = feedback = e.message;
      continue;
    }

    entry.accepted = true;
    entry.head = workspace.state().head;
    feedback = undefined;
    if (d.action !== "run_point") pendingSurprise = pendingSurprise && d.surprise === undefined;
    if (d.escalate !== undefined) {
      escalations++;
      effort = "medium";
    }
    if (d.action === "conclude") return { goal, provider: provider.name, stop: "concluded", trace };
    if (d.action === "ask_researcher") {
      return { goal, provider: provider.name, stop: "asked_researcher", trace };
    }
    turn++;
  }
  return { goal, provider: provider.name, stop: "budget_exhausted", trace };
}
