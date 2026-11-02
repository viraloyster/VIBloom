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
| `search`    | Halton sampling, transition refinement, counterexample shrinking               | `contracts`           |
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

- Each result declares its necessary assumptions. It is current only while all
  of them are current. Results with independent assumptions are evaluated
  separately.
- A claim's status is derived by the engine from current evidence. Models cannot
  write it.
- Narrowing or correcting a claim creates a new version linked to the original.
- Computational dependencies form a DAG. Informational links may form cycles.
- Edges proposed by a model start as hypothetical: they warn, they do not
  invalidate.

## Write gate

| Write                                                               | Policy                 |
| ------------------------------------------------------------------- | ---------------------- |
| Manipulate checks: disable, relax, delete evidence, rewrite results | reject                 |
| Relax or remove an invariant                                        | reject                 |
| Record evidence, including evidence that refutes a claim            | accept and propagate   |
| Change a protected assumption or the meaning of a claim             | require human approval |

Writes are atomic: validate, check the base revision, then append the event,
update the projection and record the command id in one transaction. A command
built on an old revision is rejected. Repeating a command id with the same
content returns the original result; with different content it is rejected.

## Event log and replay

- The canonical state is a projection of an append-only, hash-chained log.
- Events carry their ids and timestamps; replay never regenerates them.
- The reducer uses no network, clock or randomness.
- Three operations are kept distinct: reprojecting events (exact), replaying
  recorded model responses (matched by request hash, fails on mismatch) and
  re-running simulations (equal within declared tolerances).

## Signals

Three signals are stored separately and never merged:

- Fragility: how a property behaves under perturbation (counted pass to fail
  transitions).
- Semantic review: whether a source supports an extracted value. Probability
  scores from the open-weight model are experimental and never decide a verdict.
- Priority: where to investigate next. It may read the other two.

## Layered context for agents

Agents see the project as a virtual file tree derived from the roots map, with
a summary file per folder. Each summary records the revisions it was derived
from and goes stale when they change.
Detail depends on graph distance from the focus: details and history, details,
summary, title, collapsed folder. Required assumptions are always delivered at
detail level; if they do not fit the budget the task is split or refused.
Summaries and source text are data, never instructions.

## Execution limits

Each integration has limits on steps, function evaluations and rejected steps.
The unit of work for search and recovery is one point. Cancellation is checked
between points. A result computed on an older revision is kept as history and
does not update current conclusions.
