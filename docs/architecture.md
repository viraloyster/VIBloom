# Architecture

## Principles

- Models propose, code decides. No model output becomes a result without
  passing deterministic checks.
- Every result is reproducible: inputs, versions, seeds and hashes are recorded.
- Refuting a claim is a valid result. The system protects the record, not the
  expected outcome.

## Two domains, one core

- **Code** (`crates/vibloom`, the `vibloom` binary): the map, the run log,
  derived states, the commit check, agent hooks and an MCP server for a code
  project. See [guard.md](guard.md).
- **Chemistry** (`apps/web`, `packages/ideas`, `packages/chem`): the
  assumption tree, predictions and lessons, the recipe map and the Process
  view. Its rules are summarised in [Anticipation and
  lessons](#anticipation-and-lessons), from "In the idea tree".

Both keep a hash-chained log and derive every state from it. AI is optional
in both: whatever it proposes enters as hypothetical and passes the same
checks, and every step it can take has a manual path.

## Packages

| Package     | Responsibility                                                            | May import                    |
| ----------- | ------------------------------------------------------------------------- | ----------------------------- |
| `contracts` | Shared types and boundary validation                                      | nothing                       |
| `engine`    | Event log, write gate, derived status, dependency propagation             | `contracts`                   |
| `chem`      | Stiff solver, Oregonator models, oscillation classifier, claim evaluation | `contracts`                   |
| `ideas`     | Idea trees: protocol, optional AI client (any provider), checks, lessons  | `engine`, `chem`, `contracts` |
| `apps/web`  | Roots map, monitor, chat, recipe map, Process view                        | all packages                  |

Import boundaries are enforced by lint. Each package exposes one entry point.

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
  claim. A counterexample to it is a finding, not an integrity failure.
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
every experiment, with or without an AI connected, with these rules in
`packages/ideas/src/tree.ts`:

- A prediction is blind only if the project holds no result of the same
  experiment: the same question (and tolerance) at the same values, on any
  node, from a check or a test. The predictor's input never contains a result; a
  prediction made after one is kept but not scored.
- Explanations are accepted only after a contradicted prediction, with
  different expected outcomes and a test that changes one parameter or one
  recipe concentration; the engine runs exactly that test.
- A lesson records its identity: values, question, tolerance, recipe
  conversion version and solver version. If any of them changes, the lesson
  stays readable as history and is no longer offered as current.
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
  without asking for a prediction, since it could not be blind.
- With an AI connected, every chat request is read first (`route`): answer from the
  record, run recipe values (the person confirms; then the usual predict,
  run, explain loop), or open the recipe map. The engine keeps only roots and
  parameters that exist. The answer gets the selected root, the roots the
  read chose and those whose runs match values in the question, in full, plus
  up to 24 runs in three tiers: runs at a recipe value the question names
  (each run keeps the recipe it came from, derived from the log), then runs
  on the roots it is about, then recent ones. Each carries its recipe, whether
  it was reproduced here and whether it is still current; the input says how
  many runs were left out and whether any run at the named values exists. The
  prompt says that what is not in the input was not shown, not that it does
  not exist.
- A concluded recipe-map cell settles the reduction question at its model
  values like a run: a later prediction there is kept but not blind, and the
  experiment runs without asking for a prediction.
- A root's text is written once, by the AI or a person. The engine keeps the values each
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

## Write gate

| Write                                                               | Policy                 |
| ------------------------------------------------------------------- | ---------------------- |
| Manipulate checks: disable, relax, delete evidence, rewrite results | reject                 |
| Relax or remove an invariant                                        | reject                 |
| Record evidence, including evidence that refutes a claim            | accept and propagate   |
| Change a protected assumption or the meaning of a claim             | require human approval |

The caller sets the actor and the approval of every command: people send
commands as `human`, runs are recorded as `engine`, an AI writes as `agent`;
nothing in a command body can choose its own actor or approve itself.
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
