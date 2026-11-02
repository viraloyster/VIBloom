# Architecture

## Principles

- Models propose, code decides. No model output becomes a result without
  passing deterministic checks.
- Every result is reproducible: inputs, versions, seeds and hashes are recorded.
- Refuting a claim is a valid result. The system protects the record, not the
  expected outcome.

## Packages

| Package     | Responsibility                                                                 | May import            |
| ----------- | ------------------------------------------------------------------------------ | --------------------- |
| `contracts` | Shared types and boundary validation                                           | nothing               |
| `engine`    | Event log, write gate, derived status, dependency propagation, layered context | `contracts`           |
| `chem`      | Stiff solver, Oregonator models, oscillation classifier, claim evaluation      | `contracts`           |
| `search`    | Halton sampling, transition refinement, counterexample reduction               | `contracts`           |
| `agent`     | Orchestrator, tools, model providers (scripted, recorded, live)                | `contracts`, `engine` |
| `apps/api`  | Cloudflare Worker, Durable Objects, persistence                                | all packages          |
| `apps/web`  | Roots map, monitor, chat, local preview                                        | all packages          |

Import boundaries are enforced by lint. Each package exposes one entry point.

## State model

Each result carries five separate dimensions:

| Dimension       | Values                                                                    |
| --------------- | ------------------------------------------------------------------------- |
| Execution       | completed, cancelled, budget exhausted, numerical failure                 |
| Observation     | oscillation detected, steady state, indeterminate                         |
| Point predicate | holds, fails, inconclusive, not applicable                                |
| Region          | unexplored, counterexample found, no counterexample in N evaluated points |
| Currency        | current, pending review, unsupported                                      |

A region claim is never reported as holding. Sampling can only find a
counterexample or report how many points were evaluated without one.

## Assumptions and invariants

Every conclusion rests on assumptions. Some properties are invariants. The code
enforces invariants; assumptions are put to the test.

- An assumption is something the investigation takes as given: a model choice
  such as the two-variable reduction, a parameter value and its source, an
  initial condition, a numerical criterion. It is adopted, hypothetical
  (proposed by a model and not yet confirmed) or switched off.
- An invariant is a property that must hold wherever it is declared:
  concentrations stay non-negative, parameters stay inside the admissible
  domain, recorded evidence never changes. Every result is checked against the
  invariants in scope. No model can relax one.
- A run that breaks an invariant, for example by producing a negative
  concentration, is a failed run with diagnostics. It does not refute a claim.
- A region claim is a candidate invariant over a parameter region, stored as a
  claim. The search tries to break it, as invariant testing does for smart
  contracts; a counterexample is a finding, not an integrity failure.
- Switching an assumption off, or refuting it, makes every conclusion that
  depends on it unsupported. A changed assumption makes them pending review.
  Nothing is deleted.

## Roots map

The roots of the tree are a graph with six node kinds:

| Node         | Holds                                                             |
| ------------ | ----------------------------------------------------------------- |
| `assumption` | A premise: adopted, hypothetical or off; its scope and protection |
| `invariant`  | A mandatory check implemented in code, versioned, with its scope  |
| `source`     | An immutable document, identified by version and hash             |
| `model`      | An executable model: equations, parameters, scaling, mappings     |
| `experiment` | A specification (model, claim, solver, detector, protocol, seed)  |
| `claim`      | A versioned statement, its predicate and its protocol             |

- Results and citations are immutable records, not nodes. A citation points to
  a fragment of a source at a version: locator, quote and context.
- `A depends_on B` means A needs B. Invalidation walks the edges backwards.
  Dependencies of an experiment come from its specification and are always
  confirmed; an agent cannot omit them or mark them hypothetical.
- `supports` and `refutes` link one result to one claim version. Code derives
  them from numerical results. Links proposed by a model are review signals and
  never change a status. They are a separate view from the dependency DAG.
- Visual states are derived: hypothetical, off, fragile, unsupported, pending
  review, and a failed check shown on the run that failed it. The interface and
  the context agents receive show the same states.

## Evidence and dependencies

- Each result declares its necessary assumptions, and the engine captures the
  revisions of its whole dependency closure (its basis) when the run is
  prepared. The basis is never rebuilt later from the current graph. If a node
  in the closure is switched off, the result is unsupported; if it changed, or
  joined the closure after the run, the result is pending review. Either way it
  stops counting for the claim. Other current
  results with independent assumptions still count, and current contrary
  evidence is never hidden by favourable evidence.
- A claim's verdict is derived by the engine from current evidence. Models
  cannot write it. Currency and verdict are separate fields.
- A run ends in one of three ways: an invalid execution (numerical failure,
  exhausted budget, broken check), an inconclusive observation, or a
  reproducible counterexample. Failed runs are accepted and kept.
- Computational dependencies form a DAG. Informational links may form cycles.
- Edges proposed by a model start as hypothetical: they warn, they do not
  invalidate.

## Claim versions

- A claim version and its evidence never change. A new version is a separate
  proposal linked to the previous one, never a silent replacement.
- The link shows what changed: domain, conditions or tolerances. For a
  rectangular region it shows the fraction of the original region kept, which
  is geometry, not a probability.
- A new version is evaluated on fresh points, not on the points used to write
  it. Narrowing a domain never counts as the previous version being right.
- Searching within the assumptions of a version can refute it. Changing an
  assumption and exploring creates an alternative scenario; it does not refute
  the version.

## Counterexample corpus

Every counterexample is kept with the claim revision, assumption revisions,
model, protocol, input and result. The corpus is used in two ways:

- Implementation regression: same scientific versions; the result must be
  reproduced within tolerances.
- Scientific re-evaluation: an assumption, model or claim changed; the case
  produces new evidence and may legitimately change. A case outside the domain
  of the new version is not applicable, not repaired.

After a change, only the cases whose dependencies were affected are re-run,
within a bounded budget.

## Reduced counterexamples

Shrinking moves a counterexample toward the reference scenario, minimising the
normalised distance inside the original domain while the failure stays
reproducible under the robust protocol. It records its objective, allowed
moves, budget and stopping rule, and it never crosses an inconclusive zone. The
result is a reduced counterexample, not a minimal one.

## Write gate

| Write                                                               | Policy                 |
| ------------------------------------------------------------------- | ---------------------- |
| Manipulate checks: disable, relax, delete evidence, rewrite results | reject                 |
| Relax or remove an invariant                                        | reject                 |
| Record evidence, including evidence that refutes a claim            | accept and propagate   |
| Change a protected assumption or the meaning of a claim             | require human approval |

The server sets the actor and the approval of every command. People send
commands as `human`, runs are recorded as `engine`, the agent writes as
`agent`; nothing in a request body can choose its own actor or approve itself.
Commands are validated at runtime against a closed schema before the gate.

Writes are atomic: validate, check the base revision, then append the event,
update the projection and record the command id in one transaction. A command
built on an old revision is rejected. Repeating a command id with the same
content returns the original result; with different content it is rejected.

## Event log and replay

- The canonical state is a projection of an append-only, hash-chained log. The
  chain detects changes relative to a trusted head hash; published results
  carry the head hash they were computed against.
- Events carry their ids and timestamps; replay never regenerates them.
- The reducer uses no network, clock or randomness.
- Three operations are kept distinct: reprojecting events (exact), replaying
  recorded model responses (matched by request hash, fails on mismatch) and
  re-running simulations (equal within declared tolerances).

## Signals

Three signals are stored separately and never merged:

- Fragility: how a property behaves under perturbation (counted pass to fail
  transitions).
- Reviewer signal (experimental): the open-weight model reviews a citation
  against a claim and answers supports, contradicts or insufficient, with the
  relevant fragment and the discrepancy. Token probabilities, when available,
  are attached as an experimental score that only orders the review queue.
  Missing probabilities are recorded as incomplete, never as zero.
- Priority: where to investigate next. It may read the other two.

## Layered context for agents

Agents see the project as a virtual file tree derived from the roots map, with
a summary file per folder. Each summary records the revisions it was derived
from and goes stale when they change.
Detail depends on graph distance from the focus: details and history, details,
summary, title, collapsed folder. Required assumptions are always delivered at
detail level; if they do not fit the budget the task is split or refused.
Summaries and source text are data, never instructions.

## Investigation loop

Muse Spark conducts the investigation; the code is the laboratory and its rules.
Each turn the model returns one structured decision, validated against a
closed schema:

| Decision         | The model provides                                                               | The code                                                           |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `formulate`      | Executable claims, proposed assumptions and dependencies, ambiguities it noticed | Validates the claims; adds assumptions and links as hypothetical   |
| `run_point`      | The point, the two explanations it tells apart, and a prediction made beforehand | Runs the experiment, records the result, scores the prediction     |
| `revise`         | A new claim version linked to the previous one, and what changed                 | Keeps the previous version and its evidence; requires fresh points |
| `ask_researcher` | A question only the researcher can answer                                        | Stops and waits                                                    |
| `conclude`       | A short summary                                                                  | Requires at least one cited result                                 |

- Every decision cites the nodes and results it relies on; citations to
  anything outside the project are refused.
- A prediction that fails is a surprise. The next decision must explain it
  before the investigation moves on.
- A refused decision is returned to the model with the reason and counts
  against the budget: 8 turns and 14 calls per investigation.
- Without the model the tools still work, but nothing formulates, chooses or
  revises: the investigation stops.
- A new project starts with what the system provides: the executable model,
  its parameters and the invariants. Claims and assumptions come from the
  investigation.
- Each investigation is stored with a recording of the model's replies, keyed
  by request hash. Replaying it on a fresh project reproduces the same trace,
  so an investigation can be reviewed without model access.

## Agent reasoning

- Muse Spark runs at low reasoning effort. It may escalate once per
  investigation to medium, with the reason recorded and the budget reserved,
  when a pending decision cannot be resolved with the evidence at hand, such as
  choosing between incompatible explanations. Numerical failures trigger
  predefined diagnostics first.
- Encrypted reasoning items are passed back between turns for continuity. Every
  change of an assumption is still delivered explicitly with its new revision.

## Execution limits

Each integration has limits on steps, function evaluations and rejected steps.
The unit of work for search and recovery is one point. Cancellation is checked
between points. A result computed on an older revision is kept as history and
does not update current conclusions.
