# VIBloom

**A map of what a project assumes, what must always hold and what each change
intends, checked by code against every test run.**

When people or AI agents change a project, the reasons it works stay in
someone's head: the assumptions it rests on, the invariants it must keep, the
intention behind each change. VIBloom writes them down as roots, links each
one to the test or experiment that settles it, and derives from the runs
whether it still stands. An agent can read the map and propose changes to it;
it can never set a state.

AI is optional. VIBloom works the same without it, and when it is used it can
come from any provider. Whatever an AI proposes enters as hypothetical and
passes the same checks as anything written by hand.

Started during the Meta Global AI Developer Hackathon (November 2026); the
hackathon version is described in [HACKATHON.md](HACKATHON.md).

## Two domains

Both keep a hash-chained log and derive every state from it, so a broken
premise marks everything resting on it.

### Code (first)

`crates/vibloom`, a single Rust binary called `vibloom`:

- `.vibloom/roots.json`: assumptions, invariants linked to tests, intentions,
  watched files and what each node rests on.
- `.vibloom/log.jsonl`: every test run, hash-chained, with the hash of the
  watched files at that run.
- Derived states: holds, BROKEN, pending review (a watched file changed),
  UNSUPPORTED, AT RISK, untested, skipped, MISSING, VACUOUS (every fuzzed call
  reverted), TEST CHANGED (a protected test or what it leans on differs from
  the last commit), off. A node can accept a dependency that is off, with a
  reason, and the risk stays listed. Only a test that ran
  and passed against the current files counts as holding; every other state
  of a tested node fails the check.
- A commit check (`vibloom precommit`), a CI check (`vibloom check`) that also
  requires the log to extend the base branch's, and context for any agent
  (`vibloom context <file>`).
- An MCP server (`vibloom mcp`) and optional Claude Code hooks. Agents can
  propose nodes, each with its evidence; a person accepts or rejects them.
- For Foundry, from code and notes to a map: `vibloom survey` reads who may
  call what and what the code leans on, `--propose` files assumptions with the
  lines they come from, and `vibloom research` gives an agent the brief to find
  the rest. `vibloom gaps` shows what the tests never name.
- `vibloom edit` and `vibloom remove` change the map. No network, no stored
  key: the builder cannot sign or send a transaction.
- Runners: Foundry (`forge test --json`) and any runner that writes JUnit XML
  (cargo-nextest, pytest, Jest, mocha, Go).

No model is involved: the guard is deterministic and does not depend on any
particular agent. See [docs/guard.md](docs/guard.md).

### Chemistry

The web app (`apps/web`) turns a chemistry question into a tree of the
assumptions it rests on and tests them with Oregonator simulations of the
Belousov-Zhabotinsky reaction, built from a real recipe:

- Roots are added by hand or, with an AI connected, grown from the question.
- Before each run a prediction is recorded, by a person or the AI. It counts
  as blind only if the project holds no result of the same experiment.
- A stiff solver runs both models; code decides every verdict.
- A contradicted prediction must be explained, with a test that tells two
  explanations apart, before a lesson is recorded. The lesson keeps the
  conditions it was learned under and stops counting when they change.
- The recipe map runs the engine on recipes around the current one and shows
  which of the tree's own checks fail there.
- The Process view reads the log: who took each step, what was recorded and
  whether it reproduced here.

The solver agrees with SciPy (Radau) on Oregonator periods to a relative 5e-4
([docs/validation.md](docs/validation.md)). The chemistry is described in
[docs/science.md](docs/science.md).

## Run it

- **On a code project:** download `vibloom` from the
  [releases](https://github.com/viraloyster/VIBloom/releases) or build it with
  `cargo install --locked --git https://github.com/viraloyster/VIBloom vibloom`.
  Then, in the project:

  ```bash
  vibloom init --agent claude   # or codex; detects Foundry, Hardhat, Cargo or pytest
  vibloom check                 # run the tests and record the run
  ```

  No API key is needed: the guard is a local program, and Claude Code or
  Codex run on the plan they already use.

  See [docs/guard.md](docs/guard.md) and the two projects in
  [examples/](examples/).

- **The web app:** https://viraloyster.github.io/VIBloom/, or locally with
  `npm ci && npm run dev`. To use an AI, choose a provider in Settings
  (Anthropic, OpenAI, xAI, Gemini, OpenRouter or a local server) and enter
  your own key. The key stays in the tab (or on the device, if you ask) and is
  sent only to that provider.

## Limits

- **Simulation, not laboratory.** Chemistry verdicts come from the
  Oregonator, a semi-quantitative model of the BZ reaction. The solver is
  validated against SciPy; the model is not validated against measured
  periods of a real beaker.
- **Outside chemistry, the web app computes on assumed numbers.** It accepts
  any goal and evaluates the comparisons in the tree, but it has no
  experiments outside chemistry.
- **Two report formats.** The guard reads Foundry's JSON and JUnit XML.
- **The guard is a local check.** An agent with full control of its machine
  can skip local hooks; the boundary it cannot cross is a protected branch
  that requires `vibloom check` in CI. See [docs/guard.md](docs/guard.md).

## Repository

```
crates/vibloom    VIBloom for code (Rust): roots map, run log, commit check, MCP
apps/web          static app: the idea tree for chemistry
packages/ideas    the tree: protocol, engine rules, optional AI client
packages/chem     stiff solver, Oregonator models, recipe conversion, classifier
packages/engine   canonical JSON and hashing
packages/contracts shared types and boundary validation
tools/reference   SciPy reference data generator
examples/         a Foundry vault and a pytest ledger set up with the guard
docs/             architecture, guard, science, validation
```

## License

[MIT](LICENSE)
