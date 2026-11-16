# VIBloom for code

The guard (`crates/vibloom`, a single Rust binary called `vibloom`) brings VIBloom's roots to a
code project and to the AI agents working in it. It keeps a map of what the
project assumes, what must always hold and what each change intends, records
every test run in a local log, and derives from those runs whether each node
still stands. An agent reads the map; it can never set a state. In CI the
tests always run again, so what decides a pull request is that run, against
the guard as the base branch has it.

It reads Foundry (`forge test --json`) and any runner that writes a JUnit XML
report: cargo-nextest, pytest, Jest, mocha (Hardhat), Go and most others. No model is involved: the
guard is deterministic and runs the same with or without AI, and it does not
depend on any particular agent. Claude Code, Codex, Cursor, Aider, any other
tool or a person editing by hand all go through the same map, the same rules
and the same commit check. Integrations for a specific agent, such as the Claude
Code hooks below, are optional extras on top.

## Start

In the project's root:

```bash
vibloom init --agent claude   # or --agent codex, or both, or neither
vibloom check                 # run the tests and decide from that run
```

`init` detects Foundry, Hardhat, Cargo or pytest (`--stack` to choose), writes
the map, installs the commit check in this clone's git hooks and, with
`--agent`, connects that agent. It installs the commit check on its own only
when the project is the repository root; in a folder of a larger repository
it prints a hint, and `vibloom install-hook` adds the check when you want it.
The installed hook changes into the project folder first, and `vibloom
precommit` passes when a commit stages nothing of the project. An existing
pre-commit hook of another tool is never overwritten: `install-hook` prints
the line to add to it. If `vibloom` is not on `PATH`, the hook refuses the
commit and says so. No API key is involved anywhere: the guard is
a local program and the agent runs on whatever plan it already uses.

- `--agent claude` adds the hooks to `.claude/settings.json` and the tools to
  `.mcp.json`, keeping what those files already hold, and guards both files
  (and `.claude/settings.local.json`) so the agent cannot switch the guard off.
- `--agent codex` adds a short section to `AGENTS.md`, guards that file so a
  builder cannot commit a rewrite of the guard's instructions, and prints the
  one command that registers the tools. Codex has no hooks that can stop an
  edit while it works, so there the commit check and CI are what hold.

On a project that already has a map, `VIBLOOM_ROLE=verifier vibloom setup
claude` (or `codex`) does the same, and `vibloom install-hook` installs the
commit check in another clone.

For a Foundry project `init` asks forge for its tests (`forge test --list`), so
an invariant inherited from a base contract is found under the contract it
runs in. The same list gives the tests folder when the tests live inside the
source folder (the dapptools layout, `src/test/*.t.sol`). Each invariant found
becomes a protected node. `init` also guards what the invariants lean on: the
handlers and base contracts their test files import, and `foundry.toml`, where
the fuzz and invariant runs and depth are set. Weakening a handler or lowering
`runs` weakens an invariant without touching its test, so only the verifier
may.

What a test imports is read from forge itself: `init` runs `forge build --ast`
and follows each invariant test's `ImportDirective.absolutePath` in the
compiler's syntax trees, where remappings are resolved, so
`import "test/handlers/H.sol"` or a remapped path is found as well as
`./handlers/H.sol`. Of the files reached, those under the tests folder (or that
are test code: handlers, bases, mocks) go to `protect`, and every project file
reached, sources and handlers, becomes that invariant's `watch`; library files
(`lib/`, `node_modules/`) are left out. An edit to a source the invariant never
imports then leaves it alone. When the syntax trees are not there (forge
missing or failing, another runner), `init` reads relative imports from the
source text as before and each invariant watches the source and test folders.
`init` and `scan` say which of the two they used.

`scan` never rewrites what an existing node watches on its own: it lists the
invariants whose watch it would narrow to their import closure, and
`vibloom scan --tighten` does it. Only a watch that holds whole folders is
narrowed, and files listed by hand stay.

Add what the tests cannot say by hand, as the verifier:

```bash
export VIBLOOM_ROLE=verifier
vibloom add assumption "only add() changes total" --on inv.total-matches-added
vibloom add intention "accounting is exact" --on asm.only-add-changes-total
vibloom add invariant "shares never exceed assets" --file test/Vault.t.sol --contract VaultTest --test invariant_solvency
```

`--watch` (repeatable) sets what a node watches; a node added with `add` and a
test watches the source and test folders when none is given. `--evidence` (repeatable)
records where the node comes from. `--detail` adds a longer text, `--id` picks
the node's id, and `--unprotected` leaves an invariant's test editable by the
builder. One rule sets the stance everywhere, for `add`, for a node written
in the map without one and for an accepted proposal: an assumption is
`hypothetical` until someone adopts it, and invariants and intentions are
`adopted`. `--adopted` adopts an assumption as it is added, and
`--hypothetical` works for any kind. `add` says which stance the node got. Or
edit the map directly.

Two more commands change a node that is already there, as the verifier:

```bash
vibloom edit asm.only-add-changes-total --stance adopted --evidence "docs/design.md#roles"
vibloom remove asm.only-add-changes-total
```

`edit` takes `--title`, `--detail`, `--stance`, `--on` and `--not-on`,
`--watch` and `--unwatch`, `--evidence` and `--drop-evidence`, `--accept`
with `--reason` and `--unaccept` (at least one option is required; an empty
`--detail` clears it); the result must still be a valid map. `remove` is refused while other nodes rest on the node;
point them elsewhere first, or switch it off with `edit --stance off`. Its
recorded runs stay in the local log.

### Accepted risks

An assumption switched `off` is one the project knows does not hold, and
everything resting on it is unsupported or at risk. When that weakness is
known and acceptable, the verifier says so on the node that rests on it:

```bash
vibloom edit int.no-overdraw --accept asm.token-is-standard --reason "only USDC is listed; it takes no fee"
vibloom edit int.no-overdraw --unaccept asm.token-is-standard
```

In the map that is `"accepts": [{ "id": "asm.token-is-standard", "reason":
"..." }]`. The id must be one of the node's `depends_on` and the reason is
required; `--accept` is refused for a dependency that is not off. While the
dependency is off it no longer makes the node troubled, and the node shows it
in its state, `adopted (accepts 1 risk)`. It is never hidden: `status` ends
with an `Accepted risks:` section listing node, dependency and reason,
`status --json` carries them under `accepted_risks`, and `context` gives the
reason wherever it shows the node in full (over MCP too).

An acceptance covers an `off` dependency and nothing else. If the dependency
is switched back on, the acceptance has no effect, `status` says it can be
removed, and whatever the dependency's state is (broken, pending, untested,
at risk) counts again as it would without it. Only the verifier sets it: it
lives in the map, and the MCP `propose` tool refuses it.

### Not yet reviewed

A `hypothetical` node is one nobody has decided yet. It does not make the
check fail by default (a real map holds many hypotheses, and a check that is
always red stops being read), but it is never out of sight:

- the summary line counts them: `5 nodes, 0 need attention, 2 not yet reviewed.`;
- a node that rests on hypothetical nodes, directly or through others, says so
  in its state, `adopted (rests on 2 unreviewed)`; a hypothetical node with a
  test of its own shows `holds (unreviewed)`;
- `status` (and `check`) end with a `Not yet reviewed:` section listing each
  hypothetical node with the command that decides it, as the verifier:
  `vibloom edit <id> --stance adopted`, or `--stance off`;
- the JSON carries the count, each node's `rests_on_unreviewed`, and the list
  with both commands.

`status --strict` and `check --strict`, or `"strict": true` in the map, make
every hypothetical node, and every node resting on one, count as needing
attention, for a team that wants it in CI. Strict applies to `status`,
`run` and `check`; the commit check and the agent hooks ignore it, since only
the verifier can adopt a node and a builder held back by that could do
nothing about it.

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
deploys it. Each contract's functions are listed, its own and those of the
project's own base contracts, then the ones it takes from library code
(OpenZeppelin, Solady) after `inherited:`. The last comes from the fuzzer's own counts, and
also shows under the invariant in `vibloom context`. Both are reports, not
failures: a function may be left out on purpose, and then an assumption node
is the place to say so.

## From code and notes to a map

For a Foundry project the first draft of the map does not have to be written
from a blank page. The steps, in order:

1. **Notes.** Write what the system is meant to guarantee, in your own words,
   in `.vibloom/notes.md`. Nothing reads it but the research brief below; it is
   yours: an agent cannot edit it, and it is committed as the verifier
   (`VIBLOOM_ROLE=verifier git commit`).
2. **Survey.** `vibloom survey` runs `forge build --ast` and reads the
   compiler's syntax trees. For each contract it reports who may call each
   state-changing function (the gates), the other modifiers, the state
   variables and which functions write them, what gates an upgrade, the calls
   into other contracts and the low-level calls. It then lists assumption
   candidates and invariant candidates. Only files under Foundry's source
   folder are read as the project's own, and only contracts are reported, not
   interfaces or libraries; an abstract contract is reported only when no
   other contract of the project builds on it. Functions are the state-changing
   ones in the compiled ABI (`nonpayable` and `payable`), plus `fallback` and
   `receive`. Test code is left out: `*.t.sol`, `*.s.sol`, the map's tests
   folder, Foundry's script folder and any folder named `test`, `tests`,
   `mock` or `mocks`, in any case.

   A contract is read with everything it inherits, in other files too: the
   files it imports are loaded, base contracts are found by name through the
   imports (aliases included) and put in the order the compiler uses, and an
   internal call runs the most derived override. Functions inherited from the
   project's own files get a line each, with their own `file:line` and
   `(from Base)`; those from library files share one line:

   ```
   LatamStable (src/LatamStable.sol)
     src/LatamStable.sol:47 mint - onlyRole(MINTER_ROLE)
     from libraries: approve, burn, burnFrom, grantRole - onlyRole(getRoleAdmin(role)), permit, renounceRole - checks the caller, revokeRole - onlyRole(getRoleAdmin(role)), transfer, transferFrom, upgradeToAndCall - checks the caller
   ```

   When the source of a base was not found, the functions the compiler's ABI
   lists and the source did not explain are shown under `not resolved`, with
   the bases that are missing.

   `vibloom survey Vat Dog` prints only those contracts, their report and
   their candidates; a name that is not in the survey is an error that lists
   the names there are.

3. **Propose.** `vibloom survey --propose` files the assumption candidates as
   proposals, each with the `file:line` it comes from and a suggested node id.
   A proposal with the same title as one already pending, or as a node in the
   map, is not filed twice. Invariant candidates are only listed: an invariant
   needs a test before it can enter the map.
4. **Decide.** `vibloom proposals` lists what is pending, with the test and
   where each proposal comes from. As the verifier, accept or reject several at
   once:

   ```bash
   VIBLOOM_ROLE=verifier vibloom proposals accept p1 p2 p3 --on inv.solvency
   VIBLOOM_ROLE=verifier vibloom proposals reject p4 p5
   ```

   Each `--on` (repeatable) links the accepted nodes to a node they rest on.

5. **Research.** `vibloom research`, or the `research` tool over MCP, prints
   the brief an agent works from, kept short: the notes; the survey as one
   line per contract (its file, how many entry points are gated, open, or
   open but checking the caller, how many state variables, whether an upgrade
   gate was found, how many other contracts it calls); each candidate's title
   once, with the contracts it applies to, without the lines; and how to
   work. Before proposing anything about a contract the agent asks for its
   detail with the `survey` tool over MCP, which takes the names in
   `contracts` and gives what `vibloom survey <Contract>` prints. The
   agent reads the project's docs, audits and the standards it implements; it
   reads the chain only with read-only `cast` commands (`cast code`, `call`,
   `storage`, `implementation`, `admin`, `logs`) using `ETH_RPC_URL`, at a fixed
   `--block` that it records; and it proposes each finding with its evidence.
6. **Refine.** `vibloom edit` and `vibloom remove` fix what was accepted.

The candidates, each with the lines it comes from:

- Assumptions: whoever passes each gate is trusted with the functions it
  guards; the functions that decide who passes a gate whose check reads the
  contract's own state; the role admin of an inherited `AccessControl` and the
  ownership transfer of an inherited `Ownable`, when the code did not show who
  writes them; an initializer nobody has to authorize, called first by the
  deployer; the gate of an upgrade; each contract it calls into, as trusted to
  behave as its interface says; each kind of low-level call.
- Invariants (listed only): every restricted function reverts for a caller
  that should not get through; the contract's books stay consistent whatever
  the open functions do (an inherited function that checks the caller is not
  counted as open); the supply of an ERC-20 equals the sum of the balances; a
  paused contract stops what a pause is meant to stop.

How the survey reads a function's gate:

- A modifier on the function is its gate when its code checks the caller,
  itself or through what it calls, in any file. A caller passed as an argument
  stays the caller inside the function that receives it, so OpenZeppelin's
  `onlyRole(role)` -> `_checkRole(role, _msgSender())` is a gate by its code.
  Only a modifier whose code was not found is judged by its name (`only...`,
  `auth`, names with `role`, `owner`, `admin`).
- A function with no gate that checks the caller in its body is reported as
  `anyone, checks the caller at :LINE`; with a gate, the lines are added
  after the gate's name. A caller check is a `require` or
  `assert`, or an `if` that reverts, whose condition uses the caller
  (`msg.sender`, `tx.origin`, `_msgSender()` or a local alias of it) outside a
  `<` or `>` comparison and not only against the zero address. The caller
  compared with zero as the whole condition is a check
  (`require(msg.sender == address(0))`, a chain's own VM); a parameter the
  caller only passed on, tested against zero, is not. The caller handed to a
  call into another contract counts only when that call is `view` or `pure`
  (`require(token.hasRole(ROLE, msg.sender))`), since it then asks about the
  caller; a state-changing one (`require(gem.transferFrom(msg.sender, ...))`)
  asks the other contract to act, and is no check. An `if` that
  returns early followed by a revert counts, and so does a modifier that runs
  the function only for some callers (`if (msg.sender == admin) { _; }`). A
  check that only turns some callers away (`require(!blacklisted[msg.sender])`)
  trusts nobody and is not one. A call to code that checks the caller is
  reported at the line of the call (`upgradeToAndCall` calls the
  `_authorizeUpgrade` that the contract overrides).
- State variables are the project's own, with namespaced (ERC-7201) storage
  read as `Struct.field`. A variable is written by an entry point when code
  it runs assigns it, applies `++`, `--` or `delete` to it, or calls `push`
  or `pop` on it, also through a library that takes it as a `storage`
  parameter (`set.add(x)`). Each variable is shown as `constant`,
  `immutable`, `written by ...`, `written inside ... (run by inherited code)`,
  `set at deployment, never after` (a constructor or an initial value is the
  only writer) or `never written by this contract's own code`; a variable
  with writers that is also set in a constructor adds `, set at deployment`.
  Inline assembly with `sstore` or `tstore` is flagged
  `writes storage in assembly`, and its `call`, `delegatecall` and
  `staticcall` are reported as low-level calls `(assembly)`.
- Calls and low-level calls made by library and free functions that the
  contract's code runs are the contract's own: they run in its context
  (`SignatureChecker` asking a wallet with `staticcall`). A library function
  inherited on the `from libraries:` line keeps its
  `writes storage in assembly`.
- An entry point with no gate and no caller check named `initialize...` or
  `init` (`initializeV2`, `init_v2`, not `initiate`), or with an `initializer`
  or `reinitializer` modifier, gets the candidate that the deployer called it
  first. Whether a hand-written guard (`require(!initialized)`) really runs it
  only once is not read, and the candidate says so.
- A contract that another reported contract inherits is still reported, since
  it can be deployed alone, with an `inherited by:` line. Its candidates keep
  its own name in their ids; two contracts of one name get the file in the id
  too, so no two candidates share one.
- `fallback` and `receive` count as entry points.
- Calls with `{value: ...}` options are seen.
- For a gate whose check reads the contract's own state, the candidate says
  which functions decide who passes it.

Every fact the survey gives is read from the code, so it can be wrong about
what the code means but not invent a line that is not there. Nothing it files
counts until the verifier accepts it.

What the survey does not see:

- `selfdestruct` is not reported.
- Ether sent with `.transfer` or `.send` is not reported as a call; calls
  with `{value: ...}` options are.
- Storage written through inline assembly is flagged, but not tied to a state
  variable, so a slot a library defines and writes (`sstore` in a library
  function) never appears among a variable's writers.
- The lists of writers over-approximate: a function is listed when any path
  in its code can write the variable, whether or not it runs.
- `set at deployment` is said of an implementation behind a proxy too; the
  survey does not know a proxy's storage is not the implementation's, so for
  an upgradeable contract it says nothing about who set the value in the
  proxy.
- Where an address comes from (fixed, set by an admin, given by the caller) is
  not read, and neither is whether a hand-written initializer guard works.
- Anything outside the project's source folder, unverified or not compiled by
  `forge build --ast`, and the chain itself.

### Evidence

A node and a proposal carry an `evidence` list: where each one comes from, as
`file:line`, a URL with its section, or a chain read with its block.
`vibloom context` and `vibloom proposals` show it as `from:`. Over MCP,
`propose` requires at least one entry and takes an optional `id` for the node,
such as `asm.oracle-is-fresh`.

### Network and keys

`vibloom` itself never touches the network and stores no key (`forge` may
download a compiler when `survey` or `gaps` builds the project). The agent's own `cast`
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
  "strict": false,
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

- **assumption**: something taken as given. `hypothetical` until someone
  adopts it (in the map, with `vibloom add` and for an accepted proposal),
  `adopted` or `off`. Invariants and intentions are `adopted` unless the map
  says otherwise.
- **invariant**: a property that must always hold, tied to a test. Protected by
  default.
- **intention**: what a change or a piece of the system is meant to achieve.
- `evidence` lists where the node comes from (see Evidence above).
- `accepts` lists the dependencies that are off and that the node accepts as
  risks, each with its reason (see Accepted risks above).
- `watch` lists files, or directories ending in `/`, that the node is about.
  For a node with a test, a change to one puts the node pending review until
  the tests run again; its test file is always watched. A node without a
  test has no run to compare with, so a change never changes its state:
  `vibloom context <file>` and the hook after an edit name it as not checked
  by any test, for a person to re-read.
- `depends_on` links form a DAG; the map is rejected if they form a cycle or
  name an unknown node, or if a path leaves the repository.
- `strict` (false when not given) counts unreviewed nodes as needing
  attention (see Not yet reviewed above).

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
| TEST CHANGED   | its protected test, or a guarded file the test leans on, differs from HEAD     |
| off            | switched off by a person; a choice, not a problem                              |

Every state in the table but holds and off needs attention: `status`, `run`
and `check` exit 1, the commit check refuses and the agent is sent back. (A node
with no test of its own shows its stance, adopted or hypothetical, while what
it rests on is sound.) A test that never ran,
was skipped or went missing is not evidence, so a mistyped test name or a
deleted invariant can never read as passing. What rests on such a node is
pending review.

A failure stays a failure until a newer run passes. A pass only counts while
the files it ran against are unchanged: each run records, for each node with a
test, one digest of the files it watches at the start of the run. A file
added to a watched directory, removed or edited changes the digest. Which
files changed is read from a snapshot of the latest run's file hashes kept
next to the log; when the snapshot does not match the run a node's evidence
comes from, the reason names the node's watch instead. In a git repository a
watched directory holds what git tracks or would track there, so build output
and caches the project ignores never count.

TEST CHANGED is read from git, so it covers a change made by any route, not
only those the hooks see: a protected node's test file, the guarded handlers
and base contracts its test imports (the same files `init` and `scan` guard),
and the test configuration in `protect` (`foundry.toml` and the like, which
bear on every test; the agents' own files such as `AGENTS.md` do not count),
modified, deleted or taken out of git in the working tree or the index. The
reason names the files. It clears only when the change is committed, and the
commit check refuses a builder's commit of guarded files, so only the verifier
can clear it; the commit check counts what the verifier stages as committed.
A protected test that was never committed is not changed: the verifier added
it and has not committed it yet. Outside a git repository, or before the
first commit, nothing is compared. One `git status` call covers every node.

The whole suite is the map's `runner` with no extra arguments. A filtered run
(`vibloom run -- --mt X`) records what it ran and says nothing about the rest.

The map is checked strictly: an unknown key, such as a mistyped `watch`, is an
error, not something ignored.

## The log

The run log is local state, never committed: `<git dir>/vibloom/log.jsonl`
(one folder per project, `<git dir>/vibloom/<folder>/` for a project in a
folder of a larger repository), or `.vibloom/local/log.jsonl` without git,
which `init` lists in `.vibloom/.gitignore`. Runs recorded before `git init`
move to the git folder the first time a command runs there. Next to it,
`state.json` holds the latest run's file hashes, which only name what changed.

Each entry holds the command, every test result, one digest per node of its
watched files and any runner error, and the hash of the entry before it.
`vibloom verify` checks the chain. It catches accidental damage and casual
edits; it has no key, so a log rewritten from scratch verifies as well as a
real one. Nothing important rests on it: it is what `status`, `context`, the
hooks and the commit check read on this machine, and `check` does not read it
at all. A run whose output is not a report (a compilation error, a missing
binary) is recorded as an error, never as a pass.

Runs may happen at the same time (two agents, a hook and a person): each is
chained under a lock when it finishes, so the log stays one chain. If the log
is damaged anyway, `VIBLOOM_ROLE=verifier vibloom repair` keeps the runs
before the break and moves the rest to `log.rejected-<time>.jsonl` beside it.

Because the log is local, a fresh clone has no states: every node with a test
is untested until `vibloom check` (or `run`) runs the tests there. CI always
runs them. The guarantee on a pull request comes from CI re-running the tests
against the guard as the base branch has it (see below), not from any log.

Upgrading from 0.7.0, a committed `.vibloom/log.jsonl` is moved aside into the
local folder (`log.committed.jsonl`) by the first command that finds it, and
never read: a committed log is whatever its last committer wrote. The command
says once to take it out of git, which the verifier does with
`git rm --cached .vibloom/log.jsonl` and a commit.

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
vibloom add <kind> "<title>" [--file F --test N] [--watch P] [--on ID] [--detail D] [--id ID] [--hypothetical | --adopted] [--unprotected]   # add a node (verifier); see Start
vibloom edit <id> [--title T] [--detail D] [--stance S] [--on ID] [--not-on ID] [--watch P] [--unwatch P] [--evidence E] [--drop-evidence E] [--accept ID --reason R] [--unaccept ID]   # change a node (verifier)
vibloom remove <id>     # take a node out; refused while others rest on it (verifier)
vibloom scan [--tighten]   # add invariant tests the map does not list yet, guard the handlers they import; --tighten narrows existing watches (verifier)
vibloom survey [<Contract>...] [--propose]   # Foundry: who may call what, upgrades, external calls; --propose files assumptions
vibloom research        # the short brief an agent works from: notes, survey summary, candidate titles, how to work
vibloom status [--json] [--strict]   # derived state of every node, troubled first
vibloom run -- --mt X   # run the tests (what follows -- goes to the runner), record, show what changed
vibloom check [--base ref [--allow-guard-changes]] [--strict] [--json | --format github]   # run and decide from that run: for CI
vibloom context [file]  # what an agent should know before touching a file
vibloom gaps            # Foundry: contracts and functions no test names, handler functions that always reverted
vibloom verify          # check the local log's hash chain
vibloom repair          # set aside everything after a broken link (verifier)
vibloom precommit       # the commit check, for .git/hooks/pre-commit
vibloom proposals       # what agents proposed and nobody decided yet
VIBLOOM_ROLE=verifier vibloom proposals accept p1 p2 [--on ID]...   # or reject p1 p2
vibloom mcp             # serve the map to any MCP client over stdio
vibloom hooks           # optional: print the Claude Code hooks configuration
vibloom hook pre-tool|post-tool|stop   # optional: what those hooks call, with the hook's JSON on stdin
```

`status`, `run` and `check` print `N nodes, K need attention, M not yet
reviewed.` and then the nodes, those needing attention first (in map order),
and `run` and `check` list what changed state before the table. Output piped
to a reader that stops early (`| head`) exits quietly. `vibloom sync` is gone
(the log no longer travels with the branch); run it and it says so.

### Exit codes

Every command but the hooks:

| Exit | Meaning                                                                                                                                                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | nothing needs attention                                                                                                                                                            |
| 1    | a verdict: a node needs attention, a guard change was not approved, the commit check refused, `verify` found a broken chain                                                        |
| 2    | vibloom could not do its job: no map or an unreadable one, bad arguments, a git error, a role refused, a damaged local log, the runner did not start, timed out or wrote no report |

`vibloom hook ...` keeps the agent's hook protocol: it exits 0 with its answer
in JSON, and 1 when it fails, never 2 (which Claude Code reads as "block").

### JSON

`status --json` and `check --json` (or `check --format json`) print one object
in this shape, also when the exit is 2:

```json
{
  "format": 1,
  "exit": 1,
  "summary": {
    "nodes": 5,
    "need_attention": 1,
    "not_yet_reviewed": 2,
    "accepted_risks": 0,
    "strict": false
  },
  "nodes": [
    {
      "id": "inv.assets-match-flows",
      "kind": "invariant",
      "title": "The vault's assets equal everything deposited minus everything withdrawn",
      "stance": "adopted",
      "state": "BROKEN",
      "shown": "BROKEN",
      "troubled": true,
      "needs_attention": true,
      "reason": "failure: assertion failed",
      "files": ["test/Vault.t.sol", "src/Vault.sol", "test/handlers/VaultHandler.sol"],
      "changed": [],
      "rests_on_unreviewed": [],
      "run": 3,
      "fuzz": { "runs": 64, "calls": 2048, "reverts": 12 }
    }
  ],
  "not_yet_reviewed": [
    {
      "id": "asm.rounding-favours-the-vault",
      "title": "Rounding in withdraw always favours the vault",
      "adopt": "vibloom edit asm.rounding-favours-the-vault --stance adopted",
      "switch_off": "vibloom edit asm.rounding-favours-the-vault --stance off"
    }
  ],
  "accepted_risks": [],
  "guard": {
    "base": "origin/main",
    "base_has_map": true,
    "allowed": false,
    "changes": [
      {
        "kind": "file_changed",
        "path": "test/Vault.t.sol",
        "message": "test/Vault.t.sol: guarded file changed"
      }
    ]
  },
  "run": { "seq": 3, "command": ["forge", "test", "--json"], "error": null },
  "log_problems": [],
  "tool_error": null
}
```

- `state` is the plain label of the table above; `shown` adds what the table
  shows after it (`accepts 1 risk`, `rests on 2 unreviewed`, `unreviewed`).
- `troubled` is the node's own trouble; `needs_attention` is what counts,
  with `strict` applied.
- `reason` is one line, or null; `files` lists the node's test first, then
  what it watches; `changed` the watched files that changed since its run.
- `guard` is null without `--base`. Each change has a `kind` (`file_changed`,
  `file_removed`, `file_added`, `node_removed`, `test_changed`, `test_removed`,
  `unprotected`, `switched_off`, `accepts_added`, `dependency_removed`,
  `runner_changed`, `report_changed`, `timeout_changed`, `tests_changed`,
  `protect_removed`, `strict_off`), a `path`, a `node` when it is about one,
  and a `message`.
- `run` is null for `status`. `tool_error` is null unless the exit is 2.
  Every accepted risk is `{ "node", "dependency", "reason", "in_effect" }`.

New keys may be added; the ones above keep their meaning while `format` is 1.

`check --format github` prints the usual text and, after it, GitHub Actions
workflow commands, so the findings show as annotations on the pull request:
`::error` for each node that needs attention (on its test file, at the line
the test is defined on) and each guard change not approved, and `::warning`
for each unreviewed node and each approved guard change.

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
  node needing attention, or that comes while the local run log fails
  verification. After changing code, run `vibloom run`; nothing of the log is
  committed.

- **CI**: `vibloom check --base` runs the tests, decides from that run alone
  and refuses guard changes nobody approved, so the same rules hold on every
  pull request. See below.

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
| `research`  | the brief to start from: notes, survey summary, how to propose with evidence                   |
| `survey`    | Foundry: the full survey of the contracts named in `contracts`                                 |
| `gaps`      | Foundry: contracts and functions no test names, handlers that always reverted                  |
| `verify`    | check the local log's hash chain                                                               |
| `propose`   | propose a node with its `evidence` (required) and an optional `id`; kept apart as hypothetical |
| `proposals` | what is still pending                                                                          |

There is no tool to accept a proposal, set a state or edit the record. A
proposal waits in `.vibloom/proposals.jsonl` until the verifier runs
`VIBLOOM_ROLE=verifier vibloom proposals accept <id>`, which checks it against the map as it is and
adds it (an assumption enters as hypothetical, an invariant or intention as
adopted, and the output says which), or `reject <id>`. Models
propose; people and code decide.

## Where the rules are enforced

Everything above runs on the machine where the code is written, and anything
that controls that machine can get around it: set `VIBLOOM_ROLE`, skip the git
hook, or write any local log it likes. The boundary an agent cannot cross is
on the server: a protected branch on GitHub that only accepts pull requests
that pass `vibloom check --base` and, for guarded files, a review by their
owner.

### The check on every pull request

`vibloom check --base <ref>` reads the map as it is on `<ref>`
(`git show <ref>:<project folder>/.vibloom/roots.json`, from git, never from
the pull request's working tree) and compares the guard with it before it
runs the tests:

- **The map.** A node removed, a node's test changed or removed, `protected`
  turned off, a stance set to `off`, an `accepts` added, a `depends_on` edge
  removed, `strict` turned off, the `runner`, `report`, `timeout` or `tests`
  changed, or an entry taken out of `protect`. Adding nodes, evidence, edges,
  `protect` entries or new protected tests is not a guard change.
- **What the base's map guards.** Each protected test of the base, the
  helpers it imports and every path in the base's `protect` is compared with
  its content on `<ref>`: changed, removed, or (for a file the base listed but
  did not have, such as a `foundry.toml`) added. A new file in a guarded
  folder is new code, not a change.

Each change is listed on one line, and the check exits 1 with the sentence
that these are guard changes and need a person's review. With
`--allow-guard-changes` that part passes, and the result is what the tests
say. When `<ref>` has no map yet, it says so and passes that part.

Then it runs the tests on the CI machine and decides from that run alone:
nothing recorded before, on the author's machine or anywhere, can make a node
hold. A node whose test was not in that run is untested.

A reviewer approving guard changes approves exactly what they read: a
weakened invariant that the reviewer lets through is then what the tests
prove. That is why the approval belongs to a person.

`.github/workflows/vibloom.yml`, where a guard change passes only once a
maintainer has put the `guard-change-approved` label on the pull request, and
a new push takes the approval away:

```yaml
name: vibloom
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]
permissions:
  contents: read
  pull-requests: write
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
      - name: A new push needs a new approval
        if: github.event.action == 'synchronize'
        run: gh pr edit "${{ github.event.number }}" --remove-label guard-change-approved || true
        env:
          GH_TOKEN: ${{ github.token }}
      - name: Check
        env:
          APPROVED: ${{ github.event.action != 'synchronize' && contains(github.event.pull_request.labels.*.name, 'guard-change-approved') }}
        run: |
          allow=""
          if [ "$APPROVED" = "true" ]; then allow="--allow-guard-changes"; fi
          vibloom check --base "origin/${{ github.base_ref }}" --format github $allow
```

Only people with triage or write access can label a pull request; keep that
set to the code owners. Pin the VIBloom commit: the check is only as
trustworthy as the code that runs it.

### Owners for guarded files

`.github/CODEOWNERS`, listing the map and every protected test and guarded
file:

```
/.vibloom/            @your-handle
/test/Vault.t.sol     @your-handle
/test/handlers/       @your-handle
/foundry.toml         @your-handle
```

### Branch protection

On the main branch, in the repository settings:

- require a pull request before merging, with review from Code Owners;
- require the `vibloom / guard` status check to pass;
- do not allow bypassing these settings.

With that in place, an agent with full control of its own machine can still
write any code, but it cannot merge a change that breaks an invariant, weakens
the map or edits a protected test without the owner's review.

## Optional: Claude Code

Claude Code can call the guard while it works instead of only at commit time.
`vibloom init --agent claude` (or `vibloom setup claude`) adds the hooks to the
project's `.claude/settings.json`; `vibloom hooks` prints them. They do three
things:

- **Before a tool runs**: an edit to a protected test, to a path in `protect`
  or to `.vibloom/` is denied unless `VIBLOOM_ROLE=verifier`. Shell commands
  that plainly write to those paths (redirection, `sed -i`, `mv`, `rm`, `cp`,
  `tee`, `git checkout`, `git restore`...) are denied too, and so are commands
  that mention `VIBLOOM_ROLE` or commit with `--no-verify` (or `-n`).
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
  review, and which watching nodes no test checks, for a person to re-read,
  once per file between runs.
- **Before the agent stops**: if any node needs attention, the agent is sent
  back once. Claude Code marks the second attempt, which the guard lets
  through so the session cannot loop; the state stays visible in `vibloom
status`. If the log fails verification, the agent is sent back every time,
  with the problems.

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
4 nodes, 3 need attention, 1 not yet reviewed.
BROKEN                           inv.total-matches-added   total always equals the sum of what add() added
UNSUPPORTED (unreviewed)         asm.only-add-moves-total  Only add() changes total
AT RISK (rests on 1 unreviewed)  int.accounting-is-exact   Accounting is exact: every unit of total is traceable
holds                            inv.total-bounded         total never overflows a sane bound

Not yet reviewed (as the verifier, adopt it or switch it off):
- asm.only-add-moves-total: vibloom edit asm.only-add-moves-total --stance adopted   (or --stance off)
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
  that writes to a protected file indirectly is not caught while it runs. In a
  git repository the node then shows TEST CHANGED until the verifier commits
  the change, `git diff` shows what changed, and `check --base` in CI refuses
  it as a guard change.
- The role comes from an environment variable; it separates honest agents, it
  does not authenticate them. Code owners and branch protection are the
  boundary that does.
- The local log's hash chain has no key: it shows accidental damage, not
  forgery. Nothing that decides a pull request reads it.
- `check --base` compares the files the base guards, as the base's map names
  them. Its import graph for helpers is the relative imports in the text; the
  handlers `init` found through forge's trees are compared because they are in
  `protect`.
- A test that fails without any node resting on it is counted in the run line
  (`1 failed (1 tied to no node...)`) but does not fail the check.
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
