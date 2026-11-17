# VIBloom

**Keeps an AI coding agent from making the tests pass by weakening them.**

Ask an agent to make a failing suite green and the quickest way is often to
change the test, lower the fuzz runs or delete the invariant. `vibloom` is a
small local program that writes down what your project must always hold
(its invariant tests) and what it takes as given (assumptions), guards those
tests and that list against the agent, and decides from a fresh test run
whether each one still stands. The agent can propose; only a person at their
own terminal changes what counts. In CI, `vibloom check --base` refuses any
change that weakens the guard until a person approves it.

## Quickstart (Foundry)

Download `vibloom` for your platform from the
[releases](https://github.com/viraloyster/VIBloom/releases), or
`cargo install --locked --git https://github.com/viraloyster/VIBloom vibloom`. Then, in the project:

```bash
vibloom init              # find the invariant tests, guard them, write .vibloom/roots.json
vibloom check             # run forge test; exit 1 when anything needs attention
vibloom add "The handler covers every way assets enter or leave the vault"
vibloom                   # where things stand, and the one next step
vibloom setup claude      # or: vibloom setup codex
```

`add` writes down an assumption, not yet reviewed until you adopt it. `setup
claude` adds the hooks and tools to the project and marks the agent as the
builder; without it, an agent is still recognised by the variables Claude
Code, Codex, Cursor and Gemini CLI set.

## What a failure looks like

In [examples/foundry-vault](examples/foundry-vault/), with `totalAssets -= assets;`
commented out of `withdraw`:

```
$ vibloom check
Run 2: 3 test results recorded, 2 failed.
1 failing test no node rests on, which still fails the check: VaultTest.test_depositThenWithdrawReturnsEverything.
Fix it, or tie it to a node; a test known to be red can be listed in "ignore_failures" in the map.
Changed:
  inv.assets-match-flows: pending review -> BROKEN
  inv.shares-are-backed: pending review -> holds
  int.nobody-can-take-out-more-than: pending review -> AT RISK
4 nodes, 2 need attention, 0 not yet reviewed.
BROKEN   inv.assets-match-flows             invariant_assetsMatchFlows
AT RISK  int.nobody-can-take-out-more-than  Nobody can take out more than their shares are worth
holds    inv.shares-are-backed              invariant_sharesAreBacked
adopted  asm.the-handler-covers-every-way   The handler covers every way assets enter or leave the vault
Check failed: 2 nodes need attention, 1 failing test no node rests on.
```

An agent sent to fix it cannot edit the invariant's test or the map:

```
$ CLAUDECODE=1 vibloom edit inv.assets-match-flows --stance off
This changes the map, which is a decision for the person, not for the agent writing the code: whoever is judged by the checks must not be able to change them.
vibloom treats this command as an agent's (CLAUDECODE is set: Claude Code is running this command).
The person runs it in their own terminal: vibloom edit inv.assets-match-flows --stance off
```

## Read on

- [docs/quickstart.md](docs/quickstart.md): the path from nothing to a useful
  map, in one page.
- [docs/guard.md](docs/guard.md): the reference: every command, the map, the
  states, CI, agents, the limits.
- [After an audit](docs/guard.md#after-an-audit): tag the audited commit and
  run `vibloom diff <tag>` before each release to see what is gone, weakened
  or changed under the map since.
- [docs/format.md](docs/format.md): the map format and the JSON output, with
  their JSON Schemas in [schema/](schema/), for tools that write or read a
  map.
- [examples/](examples/): a Foundry vault and a pytest ledger set up with the
  guard. Runners other than Foundry work through JUnit XML (cargo-nextest,
  pytest, Jest, mocha, Go).

## Limits

- **A local check is a speed bump.** An agent with full control of its
  machine can unset variables or skip hooks. The boundary it cannot cross is
  a protected branch that requires `vibloom check --base` in CI and a code
  owner's review of guarded files. See
  [Where the rules are enforced](docs/guard.md#where-the-rules-are-enforced).
- **It knows only what the map says.** Passing tests do not prove a global
  property, and the guard does not discover a dependency nobody wrote down.
- **It uses other tools' results, it does not replace them.** It reads
  Foundry's JSON, JUnit XML, Halmos reports and Echidna's text summary (its
  reader follows Echidna's source and was not run against Echidna), and shows the kind
  of guarantee each gives (`holds, fuzzed 64x32`, `holds, symbolic
(bounded)`): a fuzz pass is never shown as a proof. It finds no
  vulnerabilities, assigns no severity and proves nothing itself.

No model and no API key are involved: the guard is deterministic, and Claude
Code or Codex run on the plan they already use.

## Also here: the chemistry app

The same idea, applied to science: a web app that turns a chemistry question
into a tree of the assumptions it rests on and tests them with Oregonator
simulations of the Belousov-Zhabotinsky reaction. It runs at
https://viraloyster.github.io/VIBloom/ (or locally with
`npm ci && npm run dev`); AI is optional and any provider works with your own
key. The model and its validation are in [docs/science.md](docs/science.md)
and [docs/validation.md](docs/validation.md); the code in
[docs/architecture.md](docs/architecture.md). Its verdicts come from a
simulation, not a laboratory.

Started during the Meta Global AI Developer Hackathon (November 2026); the
hackathon version is described in [HACKATHON.md](HACKATHON.md).

## Repository

```
crates/vibloom    the guard (Rust): roots map, run log, commit check, hooks, MCP
apps/web          static app: the idea tree for chemistry
packages/ideas    the tree: protocol, engine rules, optional AI client
packages/chem     stiff solver, Oregonator models, recipe conversion, classifier
packages/engine   canonical JSON and hashing
packages/contracts shared types and boundary validation
tools/reference   SciPy reference data generator
examples/         a Foundry vault and a pytest ledger set up with the guard
schema/           JSON Schemas of the map and of the JSON output
docs/             quickstart, guard reference, map format, architecture, science, validation
```

## License

[MIT](LICENSE)
