# Architecture

## Principles

- Models propose, code decides. No model output becomes a result without
  passing deterministic checks.
- Every result is reproducible: inputs, versions, seeds and hashes are recorded.
- Refuting a claim is a valid result. The system protects the record, not the
  expected outcome.

## Two domains, two implementations

VIBloom is one idea applied twice. The implementations share the design, not
the code, and their logs have different formats.

- **Code** (`crates/vibloom`, the `vibloom` binary, Rust): a map of
  assumptions, invariants and intentions for a code project, a hash-chained
  log of test runs, states derived from both, a commit check, agent hooks and
  an MCP server. Everything about it is in [guard.md](guard.md).
- **Chemistry** (`apps/web`, `packages/ideas`, `packages/chem`, TypeScript):
  an assumption tree in the browser whose experiments are Oregonator
  simulations, with predictions, lessons, the recipe map and the Process view.
  The rest of this page describes it.

What both keep: every state is derived by code from a hash-chained record,
never set by hand or by a model; what an AI proposes enters as hypothetical
and passes the same checks as what a person writes; a broken premise marks
everything that rests on it.

## Packages

| Package     | Responsibility                                                            | May import                    |
| ----------- | ------------------------------------------------------------------------- | ----------------------------- |
| `contracts` | Shared types for claims, models and results                               | nothing                       |
| `engine`    | Canonical JSON and hashing                                                | `contracts`                   |
| `chem`      | Stiff solver, Oregonator models, oscillation classifier, claim evaluation | `contracts`                   |
| `ideas`     | Idea trees: protocol, optional AI client (any provider), checks, lessons  | `engine`, `chem`, `contracts` |
| `apps/web`  | Roots map, monitor, chat, recipe map, Process view                        | all packages                  |

Import boundaries are enforced by lint. Each package exposes one entry point.

## The tree and its record

- A tree is a goal and the assumptions it rests on. Each node states one
  assumption that could be false, with the parameters it relies on and,
  where it can be computed, a check: an arithmetic comparison over
  parameters, or an Oregonator experiment.
- The engine evaluates every check; a model or a person never sets pass or
  fail. A node's status is derived from its own check and from the nodes
  under it and the nodes it cites.
- Every step is an event in an append-only, hash-chained log: who took it
  (`person`, `engine` or `ai:<model>`), what was recorded and the hash of the
  event before. Replaying the log rebuilds the tree, re-verifies every hash
  and recomputes every formula; a result that does not reproduce is shown as
  such.
- Attempts the engine refused are kept next to the log and shown in the
  Process view.

## Anticipation and lessons

VIBloom keeps what was expected, what contradicted it and which evidence
changed the explanation.

The loop runs on every experiment, with or without an AI connected, with
these rules in `packages/ideas/src/tree.ts`:

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
