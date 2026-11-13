# VIBloom for code

The guard (`crates/vibloom`, a single Rust binary called `vibloom`) brings VIBloom's roots to a
code project and to the AI agents working in it. It keeps a map of what the
project assumes, what must always hold and what each change intends, records
every test run in a hash-chained log, and derives from those runs whether each
node still stands. An agent reads the map; it can never set a state.

The first runner is Foundry (`forge test --json`). No model is involved: the
guard is deterministic and runs the same with or without AI, and it does not
depend on any particular agent. Claude Code, Codex, Cursor, Aider, any other
tool or a person editing by hand all go through the same map, the same log and
the same commit check. Integrations for a specific agent, such as the Claude
Code hooks below, are optional extras on top.

## The map

`.vibloom/roots.json`, written by people (or a verifier agent) and kept in git:

```json
{
  "version": 1,
  "runner": ["forge", "test", "--json"],
  "tests": "test/",
  "protect": ["foundry.toml"],
  "nodes": [
    {
      "id": "inv.total-matches-added",
      "kind": "invariant",
      "title": "total always equals the sum of what add() added",
      "test": {
        "file": "test/Counter.t.sol",
        "contract": "CounterTest",
        "name": "invariant_totalMatchesAdded"
      },
      "watch": ["src/Counter.sol"],
      "protected": true
    },
    {
      "id": "asm.only-add-moves-total",
      "kind": "assumption",
      "title": "Only add() changes total",
      "stance": "hypothetical",
      "depends_on": ["inv.total-matches-added"],
      "watch": ["src/Counter.sol"]
    },
    {
      "id": "int.accounting-is-exact",
      "kind": "intention",
      "title": "Accounting is exact: every unit of total is traceable",
      "depends_on": ["asm.only-add-moves-total"]
    }
  ]
}
```

- **assumption**: something taken as given. `hypothetical` (the default, for
  anything an agent proposes), `adopted` or `off`.
- **invariant**: a property that must always hold, tied to a test. Protected by
  default.
- **intention**: what a change or a piece of the system is meant to achieve.
- `watch` lists files, or directories ending in `/`, whose change puts the
  node's evidence up for review. A node's test file is always watched.
- `depends_on` links form a DAG; the map is rejected if they form a cycle or
  name an unknown node, or if a path leaves the repository.

## Derived states

| State          | When                                                                          |
| -------------- | ----------------------------------------------------------------------------- |
| holds          | the latest run of its test passed, and no watched file changed since          |
| BROKEN         | the latest run of its test failed                                             |
| pending review | it passed, but a watched file changed since; or something below it is pending |
| UNSUPPORTED    | something it depends on is broken, off or unsupported                         |
| AT RISK        | the same, for an intention                                                    |
| untested       | its test has never run                                                        |
| off            | switched off by a person; a choice, not a problem                             |

A failure stays a failure until a newer run passes. A pass only counts while
the files it ran against are unchanged: the log stores the hash of every
watched file at the start of each run. A file added to a watched directory, or
not recorded by the run, counts as changed.

## The log

`.vibloom/log.jsonl`: one entry per run, with the command, every test result,
the watched files' hashes and any runner error. Each entry carries the hash of
the one before. `vibloom verify` checks the chain; an edited or removed entry
breaks it, and nothing after the break is trusted. A run whose output is not a
report (a compilation error, a missing binary) is recorded as an error, never
as a pass.

## Install

```bash
cargo install --locked --git https://github.com/viraloyster/VIBloom vibloom
```

One binary, no runtime to install. A hook call takes about 2 ms.

## Commands

```bash
vibloom init            # create the map, adding every invariant test found under tests/
vibloom scan            # add invariant tests the map does not list yet
vibloom status          # derived state of every node; exit 1 if any needs attention
vibloom run -- --mt X   # run the tests (extra args go to the runner), record, show what changed
vibloom check           # run, then exit 1 if any node needs attention: for CI
vibloom context [file]  # what an agent should know before touching a file
vibloom verify          # check the log's hash chain
vibloom precommit       # the commit check, for .git/hooks/pre-commit
vibloom proposals       # what agents proposed and nobody decided yet
vibloom proposals accept p1 | reject p1
vibloom mcp             # serve the map to any MCP client over stdio
vibloom hooks           # optional: print the Claude Code hooks configuration
```

From this repository: `cargo run -p vibloom -- <command>`.

## With any agent

Three pieces work the same whatever writes the code:

- **Context**: give the agent the output of `vibloom context <file>` before it
  touches a file, in its prompt, rules file or tool call. It has full detail for
  the nodes that file touches, what they rest on and what rests on them, and one
  line for every other node, troubled ones first.
- **The commit check**: put `vibloom precommit` in `.git/hooks/pre-commit`:

  ```sh
  #!/bin/sh
  exec vibloom precommit
  ```

  It refuses a commit that changes a protected test, a path in `protect` or the
  map (unless `VIBLOOM_ROLE=verifier`), that leaves a node broken, unsupported
  or pending review, that includes an invariant that has never run, or that
  comes with a run log failing verification. After changing code, run
  `vibloom run` and commit the new log entry with it.

- **CI**: `vibloom check` runs the tests, records the run and exits 1 if any node
  needs attention, so the same rules hold on every pull request. See below.

## Over MCP

`vibloom mcp` serves the map to any client that speaks the Model Context
Protocol over stdio (Claude Code, Codex, Cursor and others). Register it the
way the client registers a local server, with the project as the working
directory, for example:

```bash
claude mcp add vibloom -- vibloom mcp
```

| Tool        | What it does                                                              |
| ----------- | ------------------------------------------------------------------------- |
| `status`    | the derived state of every node                                           |
| `context`   | what to know before touching a file                                       |
| `run`       | run the tests and record the run; only forge's test filters are accepted  |
| `verify`    | check the log's hash chain                                                |
| `propose`   | propose an assumption, invariant or intention, kept apart as hypothetical |
| `proposals` | what is still pending                                                     |

There is no tool to accept a proposal, set a state or edit the record. A
proposal waits in `.vibloom/proposals.jsonl` until a person runs
`vibloom proposals accept <id>`, which checks it against the map as it is and
adds it (an assumption enters as hypothetical), or `reject <id>`. Models
propose; people and code decide.

## Where the rules are enforced

Everything above runs on the machine where the code is written, and anything
that controls that machine can get around it: set `VIBLOOM_ROLE`, skip the git
hook, or rewrite `.vibloom/log.jsonl` from scratch with a valid chain of its
own. The boundary an agent cannot cross is on the server: a protected branch on
GitHub that only accepts pull requests that pass `vibloom check` and, for
guarded files, a review by their owner.

### The check on every pull request

`.github/workflows/vibloom.yml`:

```yaml
name: vibloom
on: pull_request
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          submodules: recursive
      - uses: foundry-rs/foundry-toolchain@v1
      - name: Install VIBloom at a pinned commit
        run: cargo install --locked --git https://github.com/viraloyster/VIBloom --rev <commit> vibloom
      - name: Check
        run: vibloom check --base "origin/${{ github.base_ref }}"
```

`check --base` does two things before running the tests:

- It reads the log on the base branch from git, not from the pull request, and
  refuses the pull request if its log does not keep every base run unchanged
  and in order. A log regenerated from scratch has a valid chain of its own but
  fails here.
- Then it runs the tests on the CI machine and records that run, so the result
  that decides is the one CI produced, not one recorded on the author's machine.

Pin the VIBloom commit: the check is only as trustworthy as the code that runs it.

### Owners for guarded files

`.github/CODEOWNERS`, listing the map, the log and every protected test:

```
/.vibloom/            @your-handle
/test/Counter.t.sol   @your-handle
```

### Branch protection

On the main branch, in the repository settings:

- require a pull request before merging, with review from Code Owners;
- require the `vibloom / guard` status check to pass;
- do not allow bypassing these settings.

With that in place, an agent with full control of its own machine can still
write any code, but it cannot merge a change that breaks an invariant, rewrites
the record or edits a protected test without the owner's review.

## Optional: Claude Code

Claude Code can call the guard while it works instead of only at commit time.
Add the output of `vibloom hooks` to the project's `.claude/settings.json`. The
hooks do three things:

- **Before a tool runs**: an edit to a protected test, to a path in `protect`
  or to `.vibloom/` is denied unless `VIBLOOM_ROLE=verifier`. Shell commands
  that plainly write to those paths (redirection, `sed -i`, `mv`, `rm`, `cp`,
  `tee`) are denied too.
- **After a tool runs**: after a `forge test` command, the guard re-runs the
  same subset with `--json` and records it, so the agent's own output is never
  what counts. If anything is broken, unsupported or pending, the agent is sent
  back with the list and the rule "fix the code, not the invariant". After an
  edit to a watched file, the agent is told which nodes are now pending review.
- **Before the agent stops**: if any node needs attention, or the log fails
  verification, the agent is sent back once. Claude Code marks the second
  attempt, which the guard lets through so the session cannot loop; the state
  stays visible in `vibloom status`.

Other agents with a hook or plugin system can get the same behaviour by calling
`vibloom hook pre-tool`, `post-tool` and `stop` with the same JSON input, or by
calling `vibloom status` and `vibloom run` directly.

## Two roles

Whatever the tools, the agent that writes code runs as the builder (the
default). The agent or person that writes invariants runs with
`VIBLOOM_ROLE=verifier` and is the only one allowed to change protected tests and the map. Keeping them apart means the
code is never judged by tests its own author could quietly relax.

## A worked example

A counter whose `total` must always equal what `add()` added, with a second
function, `bad()`, that moves `total` on its own. The map holds the invariant,
an assumption resting on it and an intention resting on the assumption:

```solidity
contract Counter {
    uint256 public total;
    uint256 public added;
    function add(uint256 x) external { x = x % 1000; added += x; total += x; }
    function bad(uint256 x) external { total += x % 3; }
}

function invariant_totalMatchesAdded() public view {
    assertEq(c.total(), c.added(), "total drifted from added");
}
```

The fuzzer finds the drift, and the guard carries it up the map:

```
$ vibloom check
Run 1: 3 test results recorded.
BROKEN       inv.total-matches-added   total always equals the sum of what add() added
holds        inv.total-bounded         total never overflows a sane bound
UNSUPPORTED  asm.only-add-moves-total  Only add() changes total
AT RISK      int.accounting-is-exact   Accounting is exact: every unit of total is traceable
```

An agent asked to make the suite pass has two ways out. Editing the invariant
is denied, by the Claude Code hook while it works and by `vibloom precommit` and
code owners when it tries to commit:

```
VIBloom: test/Counter.t.sol is guarded. Only the verifier role may change
protected tests and the roots map. If the test is wrong, say so and explain
why; do not change it to make it pass.
```

Fixing the code is the other. As soon as `src/Counter.sol` changes, every node
watching it is pending review, and the commit check refuses it until the tests
run again; after `bad()` is removed and the suite runs, all four nodes hold.

## Limits

- The Bash check is a heuristic on the command text, not a sandbox: a script
  that writes to a protected file indirectly is not caught. The log's hash chain
  and `git diff` still show what changed.
- The role comes from an environment variable; it separates honest agents, it
  does not authenticate them. Code owners and branch protection are the
  boundary that does.
- The log's hash chain proves the log was not edited after the fact, not that it
  was never regenerated. `check --base` against a protected branch is what
  anchors it.
- Passing tests does not prove a global property. The guard knows only what the
  map says: it keeps the written assumptions and invariants from being skipped
  or weakened, and shows what is left unsupported when something changes. It
  does not discover a dependency nobody wrote down.
- `.vibloom/proposals.jsonl` is not hash-chained: it holds suggestions, not
  evidence, and nothing in it counts until a person accepts it into the map.
- Only Foundry's JSON report is read today. Another runner needs a parser that
  returns the same outcomes.
- After a test command, the guard re-runs that subset once more. On a large
  suite, filter with `--match-path` or `--match-test`.
