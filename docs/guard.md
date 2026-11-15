# VIBloom for code

The guard (`crates/vibloom`, a single Rust binary called `vibloom`) brings VIBloom's roots to a
code project and to the AI agents working in it. It keeps a map of what the
project assumes, what must always hold and what each change intends, records
every test run in a hash-chained log, and derives from those runs whether each
node still stands. An agent reads the map; it can never set a state.

It reads Foundry (`forge test --json`) and any runner that writes a JUnit XML
report: cargo-nextest, pytest, Jest, mocha (Hardhat), Go and most others. No model is involved: the
guard is deterministic and runs the same with or without AI, and it does not
depend on any particular agent. Claude Code, Codex, Cursor, Aider, any other
tool or a person editing by hand all go through the same map, the same log and
the same commit check. Integrations for a specific agent, such as the Claude
Code hooks below, are optional extras on top.

## Start

In the project's root:

```bash
vibloom init --agent claude   # or --agent codex, or both, or neither
vibloom check                 # run the tests and record the run
```

`init` detects Foundry, Hardhat, Cargo or pytest (`--stack` to choose), writes
the map, installs the commit check in this clone's git hooks and, with
`--agent`, connects that agent. It installs the commit check on its own only
when the project is the repository root; in a folder of a larger repository
it prints a hint, and `vibloom install-hook` adds the check when you want it.
The installed hook changes into the project folder first, and `vibloom
precommit` passes when a commit stages nothing of the project. No API key is involved anywhere: the guard is
a local program and the agent runs on whatever plan it already uses.

- `--agent claude` adds the hooks to `.claude/settings.json` and the tools to
  `.mcp.json`, keeping what those files already hold, and guards both files
  (and `.claude/settings.local.json`) so the agent cannot switch the guard off.
- `--agent codex` adds a short section to `AGENTS.md` and prints the one
  command that registers the tools. Codex has no hooks that can stop an edit
  while it works, so there the commit check and CI are what hold.

On a project that already has a map, `VIBLOOM_ROLE=verifier vibloom setup
claude` (or `codex`) does the same, and `vibloom install-hook` installs the
commit check in another clone.

For a Foundry project `init` asks forge for its tests (`forge test --list`), so
an invariant inherited from a base contract is found under the contract it
runs in. The same list gives the tests folder when the tests live inside the
source folder (the dapptools layout, `src/test/*.t.sol`). Each invariant found becomes a protected node that watches the source
and test folders. `init` also guards what the invariants lean on: the handlers
and base contracts their test files import, and `foundry.toml`, where the fuzz
and invariant runs and depth are set. Weakening a handler or lowering `runs`
weakens an invariant without touching its test, so only the verifier may.

Add what the tests cannot say by hand, as the verifier:

```bash
export VIBLOOM_ROLE=verifier
vibloom add assumption "only add() changes total" --on inv.total-matches-added --hypothetical
vibloom add intention "accounting is exact" --on asm.only-add-changes-total
vibloom add invariant "shares never exceed assets" --file test/Vault.t.sol --contract VaultTest --test invariant_solvency
```

`--watch` (repeatable) sets what a node watches; a node with a test watches
the source and test folders when none is given. `--evidence` (repeatable)
records where the node comes from. Or edit the map directly.

Two more commands change a node that is already there, as the verifier:

```bash
vibloom edit asm.only-add-changes-total --stance adopted --evidence "docs/design.md#roles"
vibloom remove asm.only-add-changes-total
```

`edit` takes `--title`, `--detail`, `--stance`, `--on` and `--not-on`,
`--watch` and `--unwatch`, `--evidence` and `--drop-evidence`; the result must
still be a valid map. `remove` is refused while other nodes rest on the node;
point them elsewhere first, or switch it off with `edit --stance off`. Its
recorded runs stay in the log.

## For smart contracts

What a test suite proves is only as good as what it was asked. The map is
where that is written down, so it is worth being exact about three kinds of
thing:

- **Invariants**: what must hold after any sequence of calls. The ones that
  matter are usually about accounting (assets equal the sum of what entered
  minus what left), solvency (what can be claimed never exceeds what is
  held), access (only a role can move a parameter) and monotonic quantities (a
  nonce, a share price that never falls on deposit). Each is a node tied to
  its `invariant_` test.
- **Assumptions**: what the code takes as given and no test of yours proves:
  the token is a standard ERC-20 (no fee on transfer, no rebase), the oracle
  is fresh and correct, the admin key is safe, rounding always favours the
  protocol, the handler covers every entry point. Write each as an assumption
  node on the invariants it supports. It starts hypothetical; when it is
  switched off or contradicted, everything resting on it shows as unsupported.
- **Intentions**: what a contract or a change is for ("nobody can take out
  more than their shares are worth"), resting on the invariants and
  assumptions that make it true. An intention at risk is the plain-language
  answer to "what did this break?".

The guard also reads how hard each invariant was pushed. `vibloom context`
shows `fuzzed: 64 runs, 2048 calls, 12 reverted` under an invariant, and a
pass in which every call reverted (or none was made) is not a pass: the node
is VACUOUS and the check fails, because a handler that never gets a call
through tests nothing. With `fail_on_revert = false` that is the easiest way
for an invariant to go green without meaning it.

An invariant holding says nothing about code the fuzzer never reached.
`vibloom gaps` lists the ways that happens, in this order:

```
Contracts no file under test/ names, so no test reaches any of their functions:
- Treasury (src/Treasury.sol): sweep, pause
State-changing functions no file under test/ names, so no test can reach them:
- Vault (src/Vault.sol): sweep; inherited: setFee
Handler functions whose every call reverted in the latest run:
- VaultHandler.overdraw
```

The first two come from the compiled contracts and the text of the test files:
a name that appears there may still not be exercised, but one that does not
appear cannot be. A contract no test names is listed on its own, since no test
deploys it. Each contract's functions are listed, then the ones it takes from a base
after `inherited:`. The last comes from the fuzzer's own counts, and
also shows under the invariant in `vibloom context`. Both are reports, not
failures: a function may be left out on purpose, and then an assumption node
is the place to say so.

## From code and notes to a map

For a Foundry project the first draft of the map does not have to be written
from a blank page. The steps, in order:

1. **Notes.** Write what the system is meant to guarantee, in your own words,
   in `.vibloom/notes.md`. Nothing reads it but the research brief below; it is
   yours.
2. **Survey.** `vibloom survey` runs `forge build --ast` and reads the
   compiler's syntax trees. For each contract it reports who may call each
   state-changing function (the gates), the other modifiers, the state
   variables and which functions write them, what gates an upgrade, the calls
   into other contracts and the low-level calls. It then lists assumption
   candidates and invariant candidates. Test code is left out: `*.t.sol`,
   `*.s.sol`, the tests and script folders and any folder named `test`,
   `tests`, `mock` or `mocks`.
3. **Propose.** `vibloom survey --propose` files the assumption candidates as
   proposals, each with the `file:line` it comes from and a suggested node id.
   One already pending, or already in the map, is not filed twice. Invariant
   candidates are only listed: an invariant needs a test before it can enter
   the map.
4. **Decide.** `vibloom proposals` lists what is pending, with the test and
   where each proposal comes from. As the verifier, accept or reject several at
   once:

   ```bash
   VIBLOOM_ROLE=verifier vibloom proposals accept p1 p2 p3 --on inv.solvency
   VIBLOOM_ROLE=verifier vibloom proposals reject p4 p5
   ```

   Each `--on` (repeatable) links the accepted nodes to a node they rest on.

5. **Research.** `vibloom research`, or the `research` tool over MCP, prints
   the brief an agent works from: the notes, the survey and how to work. The
   agent reads the project's docs, audits and the standards it implements; it
   reads the chain only with read-only `cast` commands (`cast code`, `call`,
   `storage`, `implementation`, `admin`, `logs`) using `ETH_RPC_URL`, at a fixed
   `--block` that it records; and it proposes each finding with its evidence.
6. **Refine.** `vibloom edit` and `vibloom remove` fix what was accepted.

How the survey reads a function's gate:

- A modifier or a role check on the function is its gate.
- A function with no gate that checks the caller in its body is reported as
  `anyone, checks the caller at :LINE`. A caller check is a `require` or
  `assert`, or an `if` that reverts, whose condition uses the caller
  (`msg.sender`, `tx.origin`, `_msgSender()` or a local alias of it) outside a
  `<` or `>` comparison and not only against the zero address.
- `fallback` and `receive` count as entry points.
- Calls with `{value: ...}` options are seen.
- For a gate whose check reads the contract's own state, the candidate says
  which functions decide who passes it.

Every fact the survey gives is read from the code, so it can be wrong about
what the code means but not invent a line that is not there. Nothing it files
counts until the verifier accepts it.

### Evidence

A node and a proposal carry an `evidence` list: where each one comes from, as
`file:line`, a URL with its section, or a chain read with its block.
`vibloom context` and `vibloom proposals` show it as `from:`. Over MCP,
`propose` requires at least one entry and takes an optional `id` for the node,
such as `asm.oracle-is-fresh`.

### Network and keys

`vibloom` never touches the network and stores no key. The agent's own `cast`
reads use the `ETH_RPC_URL` of the person's environment. The Claude Code
pre-tool hook (see below) denies the commands that would send a transaction.

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
- `evidence` lists where the node comes from (see Evidence above).
- `watch` lists files, or directories ending in `/`, whose change puts the
  node's evidence up for review. A node's test file is always watched.
- `depends_on` links form a DAG; the map is rejected if they form a cycle or
  name an unknown node, or if a path leaves the repository.

## Runners

Without `report`, the map's `runner` (by default `forge test --json`) is read as
Foundry's JSON. With `report`, the runner writes a JUnit XML file there and the
guard reads it:

```json
{ "runner": ["pytest", "-q", "--junitxml=out/junit.xml"], "report": "out/junit.xml" }
{ "runner": ["cargo", "nextest", "run", "--profile", "ci"], "report": "target/nextest/ci/junit.xml" }
{ "runner": ["npx", "hardhat", "test"], "report": "out/junit.xml" }
```

(cargo-nextest writes JUnit when its profile sets `junit.path`; Hardhat through
a mocha reporter such as `mocha-junit-reporter` set in `hardhat.config`.)

- The report is deleted before each run: a report left by an earlier run is
  never read as the current one. A run that writes no report is an error.
- A test is `{ "file", "contract", "name" }`. With JUnit, `contract` is the
  test case's `classname` and `name` its `name`. `file` is always the test's
  source file in the project, since it is protected and watched; it is also
  matched against the report when the report names a file. Most reports
  (nextest's, pytest's by default) do not, so set `contract` to tell apart
  two tests with the same name.
- `vibloom scan` finds Foundry invariant tests only; other tests go in the map
  with `vibloom add`.
- `"timeout"` in the map is the number of seconds a run may take (3600 when
  not given). A run that does not finish is stopped and recorded as an error.

## Derived states

| State          | When                                                                           |
| -------------- | ------------------------------------------------------------------------------ |
| holds          | the latest run of its test passed, and no watched file changed since           |
| BROKEN         | the latest run of its test failed                                              |
| pending review | it passed, but a watched file changed since; or something below it is pending  |
| UNSUPPORTED    | something it depends on is broken, off or unsupported                          |
| AT RISK        | the same, for an intention                                                     |
| untested       | its test has never run                                                         |
| skipped        | the latest run skipped its test                                                |
| MISSING        | its test ran once, but the latest run of the whole suite did not include it    |
| VACUOUS        | its invariant passed, but every call the fuzzer made reverted, or it made none |
| off            | switched off by a person; a choice, not a problem                              |

Every state in the table but holds and off needs attention: `status` and
`check` exit 1, the commit check refuses and the agent is sent back. (A node
with no test of its own shows its stance, adopted or hypothetical, while what
it rests on is sound.) A test that never ran,
was skipped or went missing is not evidence, so a mistyped test name or a
deleted invariant can never read as passing. What rests on such a node is
pending review.

A failure stays a failure until a newer run passes. A pass only counts while
the files it ran against are unchanged: the log stores the hash of every
watched file at the start of each run. A file added to a watched directory, or
not recorded by the run, counts as changed. In a git repository a watched
directory holds what git tracks or would track there, so build output and
caches the project ignores never count.

The whole suite is the map's `runner` with no extra arguments. A filtered run
(`vibloom run -- --mt X`) records what it ran and says nothing about the rest.

The map is checked strictly: an unknown key, such as a mistyped `watch`, is an
error, not something ignored.

## The log

`.vibloom/log.jsonl`: one entry per run, with the command, every test result,
the watched files' hashes and any runner error. Each entry carries the hash of
the one before. `vibloom verify` checks the chain; an edited or removed entry
breaks it, and nothing after the break is trusted. A run whose output is not a
report (a compilation error, a missing binary) is recorded as an error, never
as a pass.

Runs may happen at the same time (two agents, a hook and a person): each is
chained under a lock when it finishes, so the log stays one chain. If the log
is damaged anyway, `VIBLOOM_ROLE=verifier vibloom repair` keeps the runs
before the break and moves the rest to `.vibloom/log.rejected-<time>.jsonl`.

## Install

Download the binary for your platform from the
[releases](https://github.com/viraloyster/VIBloom/releases) (Linux x86_64
and arm64, macOS arm64 and x86_64, Windows x86_64) and check it against its
`.sha256` file. The binaries are not code-signed yet. Or build it:

```bash
cargo install --locked --git https://github.com/viraloyster/VIBloom vibloom
```

One binary, no runtime to install. A hook call takes about 2 ms.

A release is made by raising `version` in `crates/vibloom/Cargo.toml` and
either pushing a tag `guard-v<version>` or running the Release guard workflow
by hand with "publish" on, which tags the commit itself. The workflow builds
and tests every platform first; run by hand without "publish", that is all it
does.

## Commands

```bash
vibloom init [--agent claude|codex]   # create the map, install the commit check, connect an agent
vibloom setup claude|codex   # connect an agent to an existing map (verifier)
vibloom install-hook    # install the commit check in another clone
vibloom add <kind> "<title>" ...   # add a node (verifier); see Start
vibloom edit <id> [--title T] [--detail D] [--stance S] [--on ID] [--not-on ID] [--watch P] [--unwatch P] [--evidence E] [--drop-evidence E]   # change a node (verifier)
vibloom remove <id>     # take a node out; refused while others rest on it (verifier)
vibloom scan            # add invariant tests the map does not list yet (verifier)
vibloom survey [--propose]   # Foundry: who may call what, upgrades, external calls; --propose files assumptions
vibloom research        # the brief an agent works from to find and propose nodes
vibloom status [--json] # derived state of every node, troubled first; exit 1 if any needs attention
vibloom run -- --mt X   # run the tests (what follows -- goes to the runner), record, show what changed
vibloom check           # run, then exit 1 if any node needs attention: for CI
vibloom sync --base origin/main   # take the base's run log and record the tests on top of it
vibloom context [file]  # what an agent should know before touching a file
vibloom gaps            # Foundry: contracts and functions no test names, handler functions that always reverted
vibloom verify          # check the log's hash chain
vibloom repair          # set aside everything after a broken link (verifier)
vibloom precommit       # the commit check, for .git/hooks/pre-commit
vibloom proposals       # what agents proposed and nobody decided yet
VIBLOOM_ROLE=verifier vibloom proposals accept p1 p2 [--on ID]...   # or reject p1 p2
vibloom mcp             # serve the map to any MCP client over stdio
vibloom hooks           # optional: print the Claude Code hooks configuration
```

`status` starts with `N nodes, K need attention.` and lists the troubled nodes
first. Output piped to a reader that stops early (`| head`) exits quietly.

From this repository: `cargo run -p vibloom -- <command>`.

## With any agent

Three pieces work the same whatever writes the code:

- **Context**: give the agent the output of `vibloom context <file>` before it
  touches a file, in its prompt, rules file or tool call. It is short: full
  detail only for the nodes that name the file (they watch it exactly, it is
  their test, or they cite it in evidence), one line for nodes that only watch
  its folder or are connected to those, the reason for any trouble elsewhere,
  and a count of the rest.
- **The commit check**: `vibloom install-hook` puts `vibloom precommit` in this
  clone's `.git/hooks/pre-commit` (git does not share hooks, so each clone
  installs its own). It refuses a commit that changes a protected test, a path
  in `protect` or the map (unless `VIBLOOM_ROLE=verifier`), that leaves any
  node needing attention, or that comes with a run log failing verification. After changing code, run
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

| Tool        | What it does                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `status`    | the derived state of every node                                                                |
| `context`   | what to know before touching a file                                                            |
| `run`       | run the tests and record the run; only forge's test filters are accepted                       |
| `research`  | the brief to start from: notes, survey, how to propose with evidence                           |
| `gaps`      | Foundry: contracts and functions no test names, handlers that always reverted                  |
| `verify`    | check the log's hash chain                                                                     |
| `propose`   | propose a node with its `evidence` (required) and an optional `id`; kept apart as hypothetical |
| `proposals` | what is still pending                                                                          |

There is no tool to accept a proposal, set a state or edit the record. A
proposal waits in `.vibloom/proposals.jsonl` until the verifier runs
`VIBLOOM_ROLE=verifier vibloom proposals accept <id>`, which checks it against the map as it is and
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

### When the base branch moves on

The log is one chain, so two branches that both recorded runs cannot both
keep them: after the first is merged, the second no longer extends the base
and git reports a conflict in `.vibloom/log.jsonl`. On the second branch:

```bash
git merge origin/main        # or rebase; ignore the conflict in the log
vibloom sync --base origin/main
git add .vibloom/log.jsonl
```

`sync` takes the base's log as it is and records the tests again on top of
it, on the merged code. The branch's earlier runs are dropped; what counts is
the run made after the merge.

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
`vibloom init --agent claude` (or `vibloom setup claude`) adds the hooks to the
project's `.claude/settings.json`; `vibloom hooks` prints them. They do three
things:

- **Before a tool runs**: an edit to a protected test, to a path in `protect`
  or to `.vibloom/` is denied unless `VIBLOOM_ROLE=verifier`. Shell commands
  that plainly write to those paths (redirection, `sed -i`, `mv`, `rm`, `cp`,
  `tee`, `git checkout`, `git restore`...) are denied too, and so are commands
  that set `VIBLOOM_ROLE` or commit with `--no-verify`.
  Commands that would sign or send a transaction are denied for the builder:
  `cast send`, `cast publish`, `cast mktx`, `cast wallet`, `forge create`,
  `forge script ... --broadcast` and any `--private-key`, `--mnemonic`,
  `--ledger`, `--trezor` or `--keystore` flag. Reads such as `cast call` pass.
- **After a tool runs**: after a command that runs the project's tests, the
  guard runs them itself and records that, so the agent's own output is never
  what counts. With Foundry it re-runs the same subset (`--match-test` and the
  other filters); with another runner, the whole suite. If anything is broken, unsupported or pending, the agent is sent
  back with the list and the rule "fix the code, not the invariant". After an
  edit to a watched file, the agent is told which nodes are now pending
  review, once per file between runs.
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
- Two report formats are read: Foundry's JSON and JUnit XML. A runner that
  writes neither needs a parser that returns the same outcomes.
- After a test command, the guard re-runs that subset once more. On a large
  suite, filter with `--match-path` or `--match-test`.
