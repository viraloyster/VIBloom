# Architecture

## Principles

- Models propose, code decides. No model output becomes a result without
  passing deterministic checks.
- Every result is reproducible: inputs, versions, seeds and hashes are recorded.
- Refuting a claim is a valid result. The system protects the record, not the
  expected outcome.

## Two systems in one repository

- **The public app** (`apps/web/index.html`, `packages/ideas`, `packages/chem`):
  the assumption tree, Muse's predictions and lessons, the recipe map and the
  Process view. Its rules are summarised in [Anticipation and
  lessons](#anticipation-and-lessons), from "In the idea tree".
- **The research bench** (`apps/web/bench.html`, `apps/api`, `packages/engine`,
  `packages/agent`, `packages/search`): claims over parameter regions,
  counterexample search and a multi-turn investigator agent. It runs locally
  with the Worker and is not part of the public app. Most sections below,
  from "State model" on, describe it.

Both share `contracts`, the chemistry engine and the hash-chained log.

## Packages

| Package     | Responsibility                                                                 | May import                    |
| ----------- | ------------------------------------------------------------------------------ | ----------------------------- |
| `contracts` | Shared types and boundary validation                                           | nothing                       |
| `engine`    | Event log, write gate, derived status, dependency propagation, layered context | `contracts`                   |
| `chem`      | Stiff solver, Oregonator models, oscillation classifier, claim evaluation      | `contracts`                   |
| `search`    | Halton sampling, transition refinement, counterexample reduction               | `contracts`                   |
| `agent`     | Orchestrator, tools, model providers (scripted, recorded, live)                | `contracts`, `engine`         |
| `ideas`     | Idea trees: protocol, Muse client (text, vision), ledger, checks, lessons      | `engine`, `chem`, `contracts` |
| `apps/api`  | Cloudflare Worker, Durable Objects, persistence                                | all packages                  |
| `apps/web`  | Roots map, monitor, chat, local preview                                        | all packages                  |

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

The roots of the tree are a graph with seven node kinds:

| Node         | Holds                                                             |
| ------------ | ----------------------------------------------------------------- |
| `assumption` | A premise: adopted, hypothetical or off; its scope and protection |
| `invariant`  | A mandatory check implemented in code, versioned, with its scope  |
| `source`     | An immutable document, identified by version and hash             |
| `model`      | An executable model: equations, parameters, scaling, mappings     |
| `experiment` | A specification (model, claim, solver, detector, protocol, seed)  |
| `claim`      | A versioned statement, its predicate and its protocol             |
| `lesson`     | What an unexpected result taught or left open, and its premises   |

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

## Anticipation and lessons

VIBloom keeps what was expected, what contradicted it and which evidence
changed the explanation.

- Before every run the model predicts the outcome. A failed prediction is a
  surprise, and the discrepancy is recorded with its numbers.
- After a surprise the model writes a lesson: candidate explanations, each
  blaming specific roots and expecting a measurable result in one new run
  (an outcome, or a range of the relative period error). The engine rejects
  candidates whose expectations a single result could meet together, and a
  test at the surprising point itself. When no such test can be written, the
  lesson stays open and says what information is missing.
- Support is derived from the test result: one candidate fits (supported
  under the tested conditions, not proven to be the cause), several fit (not
  distinguished) or none fits. The model never sets it.
- A lesson rests on every premise of the result it explains. If one changes
  it goes pending review; if one is switched off, unsupported. Only a person
  retires a lesson.
- Lessons appear in the context of later decisions, so what was learned
  shapes what is tried next. Whether a lesson improves later predictions is
  measured by comparing equivalent investigations with and without it.

In the idea tree (`packages/ideas`, the public app) the same loop runs on
every experiment while Muse is connected, with these rules in
`packages/ideas/src/tree.ts`:

- A prediction is blind only if the project holds no result of the same
  experiment: the same question (and tolerance) at the same values, on any
  node, from a check or a test. Muse's input never contains a result; a
  prediction made after one is kept but not scored.
- Explanations are accepted only after a contradicted prediction, with
  different expected outcomes and a test that changes one parameter or one
  recipe concentration; the engine runs exactly that test.
- A lesson records its identity: values, question, tolerance, recipe
  conversion version and solver version. If any of them changes, the lesson
  stays readable as history and is no longer offered to Muse as current.
- Selecting a root lights its foundations: the transitive closure of its
  sub-roots and the roots it cites as basis, which is what its status is
  derived from.
- The recipe map (`packages/ideas/src/map.ts`) runs the reduction experiment
  on recipes around the tree's and evaluates the tree's own target and other
  recipe-dependent checks at each, with the period taken from that run. A
  finished map is appended as a `map` event: centre, axes, the person's
  concentration limit, recipe and solver versions, and each cell's period,
  gap and verdicts; `npm run verify` replays the log up to it and runs every
  cell again. Choosing a recipe appends the person's changes and the chosen
  run (`check` with `via: "map"`); a question that run already settles is run
  without asking Muse, since a prediction could not be blind.
- Every chat request is read by Muse first (`route`): answer from the
  record, run recipe values (the person confirms; then the usual predict,
  run, explain loop), or open the recipe map. The engine keeps only roots and
  parameters that exist. The answer gets the selected root, the roots the
  read chose and those whose runs match values in the question, in full, plus
  every run in the tree; the prompt says that what is not in the input was not
  shown, not that it does not exist.
- A root's text is Muse's, written once. The engine keeps the values each
  root was written with; when a value its text quotes has changed, the
  monitor says so next to the verdict, which is always for today's values.

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

Writes are atomic: validate and check the base revision, store the event, and
only then publish the new projection and command id in memory. If storing
fails, nothing changes and the same command can be retried. A command
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
- Reviewer signal (experimental): Muse Spark reviews a citation
  against a claim and answers supports, contradicts or insufficient, with the
  relevant fragment and the discrepancy. Token probabilities, when available,
  are attached as an experimental score that only orders the review queue.
  Missing probabilities are recorded as incomplete, never as zero.
- Priority: where to investigate next. It may read the other two.

## Layered context for agents

Agents see the project as a virtual folder tree derived from the roots map
(`assumptions/`, `claims/`, `lessons/`...), the same nodes and revisions the
tree draws. The root the researcher selects is the focus, and detail depends on
graph distance from it: details and history (distance 0 or 1), details (2), a
short summary (3), a title (further away). Everything the focus rests on is
always given in full, however deep. Results appear in full only where they
touch detailed roots; the rest are counted. Without a focus every root is given
in full. Summaries and source text are data, never instructions.

## Investigation loop

Muse Spark conducts the investigation; the code is the laboratory and its rules.
Each turn the model returns one structured decision, validated against a
closed schema:

| Decision         | The model provides                                                                                                                              | The code                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `formulate`      | Executable claims, proposed assumptions and dependencies, ambiguities it noticed                                                                | Validates the claims; adds assumptions and links as hypothetical                                                                                |
| `run_point`      | The point, the two explanations it tells apart, and a prediction made beforehand                                                                | Runs the experiment, records the result, scores the prediction                                                                                  |
| `stress_test`    | A search budget and seed, and a prediction: counterexample or none                                                                              | Runs the Halton search, records every point as a result, scores the prediction on the region                                                    |
| `diagnose`       | After a surprise: candidate causes, the roots each blames, and one test run where they expect different results; or what information is missing | Writes a lesson with the numbers of the discrepancy and every premise; derives its support from the test                                        |
| `revise`         | A new claim version linked to the previous one, and what changed                                                                                | Keeps the previous version and its evidence; requires fresh points                                                                              |
| `ask_researcher` | A question only the researcher can answer                                                                                                       | Stops and waits                                                                                                                                 |
| `conclude`       | The claim, its verdict, the results used, limits and an interpretation                                                                          | Checks the verdict against the derived one and that the results are current results of that claim; the interpretation stays the model's reading |

- Every decision cites the nodes and results it relies on; citations to
  anything outside the project are refused. A citation identifies evidence; it
  does not certify an explanation.
- Results carry the measurements behind them: each model's observation and
  period, and the relative period error with its tolerance.
- A claim is tested only under its own initial condition. Fresh points are
  compared as the engine stores them, with the claim's fixed values filled in.
- A prediction names the assumptions it rests on. A prediction that fails is
  a surprise, and the next decision must diagnose it (or ask the researcher)
  before the investigation moves on.
- Every action carries the revision the model saw. If the project changed
  while the model was deciding (for example, a person switched an assumption
  off), the decision is refused and the model decides again on the new context.
- A refused decision is returned to the model with the reason and counts
  against the budget: 8 turns and 14 calls per investigation.
- Without the model the tools still work, but nothing formulates, chooses or
  revises: the investigation stops.
- Selecting a root in the tree makes it the focus of the next investigation:
  the model receives the node, what it rests on, what rests on it, and the
  results and lessons that touch it. The tree and the context the model reads
  are two views of the same nodes and revisions; the model never chooses where
  or how anything is drawn.
- A new project starts with what the system provides: the executable model,
  its parameters and the invariants. Claims and assumptions come from the
  investigation.
- Each investigation is stored with a recording of the model's replies, keyed
  by request hash. Replaying it on a fresh project reproduces the same trace,
  so an investigation can be reviewed without model access.

## Model spending

A deployment-wide object holds a daily allowance of model calls
(`MAX_DAILY_MODEL_CALLS`). Each investigation reserves its worst case, 14 calls,
before it starts and returns what it did not use, so new project names cannot
multiply the spend. Every call has a timeout, and token usage is stored with
the investigation even when it does not conclude.

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
A point evaluation runs both models under the robust protocol, about 0.7 s of
CPU on a laptop; a stress test is capped at 12 points (about 8 s), inside the
30 s CPU limit configured for the Worker.
The unit of work for search and recovery is one point. Cancellation is checked
between points. A result computed on an older revision is kept as history and
does not update current conclusions.
