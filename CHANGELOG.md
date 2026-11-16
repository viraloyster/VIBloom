# Changelog

Changes to the `vibloom` binary. The web app is not versioned.

## 0.7.0

### Added

- Accepted risks. `vibloom edit <id> --accept <dep> --reason "..."` (and
  `--unaccept`) lets a node rest on a dependency that is switched off on
  purpose: the node is no longer at risk or unsupported because of it, its
  state reads `adopted (accepts 1 risk)`, and `status` ends with an
  `Accepted risks:` section with each reason (`accepted_risks` in
  `status --json`; the reason in `context`). It covers only a dependency that
  is off; once that is on again it has no effect and `status` says it can be
  removed. Only the verifier sets it; MCP `propose` refuses it.
- TEST CHANGED: in a git repository, a protected test, a guarded handler it
  imports or the test configuration in `protect` that differs from `HEAD`
  makes the node troubled in `status`, `check`, `precommit`, the stop hook and
  MCP, whatever route the change took. It clears when the change is
  committed, which only the verifier may do.
- `vibloom survey <Contract>...` prints only those contracts, and the MCP
  `survey` tool does the same for the names in `contracts`.

### Changed

- `vibloom research` (and the MCP tool) is short: the notes, one line per
  contract with its counts, each candidate's title once with the contracts it
  applies to, and how to work, which asks the agent to get a contract's
  detail with `survey` before proposing anything about it. On MakerDAO's dss
  it went from 34.7 KB to 7.8 KB.
- One stance rule: an assumption is `hypothetical` until someone adopts it,
  and invariants and intentions are `adopted`, whether added with
  `vibloom add` (which used to adopt assumptions), written in the map or
  accepted from a proposal. `add --adopted` adopts an assumption as it is
  added; `add` and `proposals accept` say which stance the node got.
- `init --agent codex` and `setup codex` guard `AGENTS.md`.
- After an edit, and in `context <file>`, nodes that watch the file but have
  no test are named as not checked by any test, for a person to re-read.

## 0.6.2

### Fixed

- The Claude Code pre-tool hook reads the paths a shell command names the way
  the shell does: `./test/./A.t.sol`, `test//A.t.sol`, globs, quotes and
  backslashes inside a name, a different case, and a file named after
  `cd test &&` are all seen. A folder named to `rm`, `mv`, `cp`, `find` or
  `git checkout`/`restore`/`stash` (`git checkout HEAD~1 -- test`, `-- .`)
  reaches the guarded files in it.
- More ways to write a file are denied for the builder when they name a guarded
  path: `sed --in-place`, `perl`, `python`, `node` and other interpreters,
  `install`, `rsync`, `ln`, `patch`, `xargs` and `find -exec`. So are
  `cast rpc eth_sendRawTransaction`, `--unlocked`, `core.hooksPath` and writes
  to `.git/hooks/`, which would skip the commit check.
- A map that cannot be read no longer switches the hooks off: while it is
  broken the builder's edits and shell writes are denied, and stopping is sent
  back once.
- The stop hook lets the agent stop on its second try when the run log fails
  verification, instead of sending it back for ever; only the verifier can
  repair the log.
- After an edit, the hook no longer says that a node without a test went
  pending review; it names such nodes apart, to be checked by hand.
- `vibloom survey`, `gaps` and `research` rebuild the syntax trees when a test
  run recompiled a file without them, instead of finding no contracts.
  `survey --propose` does not file again what the verifier rejected.
- A watched folder written without its `/` (`--watch src`, or by hand) is read
  as a folder, and `edit --watch`/`--unwatch` take paths as `add` does. The map
  refuses paths with `.` or empty parts, and titles with a line break.
- Over MCP, an argument of the wrong type is an error instead of being read as
  empty (`run` with a string for `filters` ran the whole suite), `context` with
  a path outside the project is an error, a malformed `test` is refused instead
  of dropped, and `propose` limits the length of what it files.
- A proposal id is never reused after a line of `proposals.jsonl` is lost, and
  a proposal named twice in one `accept` or `reject` is decided once.
- `run` and `check` count failed tests, including those no node rests on.
- `vibloom precommit` outside a git repository says so in one line, `context`
  with a file outside the project is an error, `init` on an existing map points
  to `setup`, and accepting a proposal whose id is taken says so.

## 0.6.1

### Fixed

- `vibloom survey` no longer counts the caller handed to a state-changing call
  into another contract as a caller check: `require(gem.transferFrom(msg.sender,
...))` was reported as `checks the caller`. A `view` or `pure` call that asks
  about the caller (`hasRole(role, msg.sender)`) still is one.
- `require(msg.sender == address(0))` is a caller check again: the zero-address
  exclusion is for parameters the caller only passed on.
- An initializer guarded by its own code (`require(!initialized)`, a version
  check) gets the "called by the deployer first" candidate, known by its name
  (`initialize...`, `init`); a `reinitializer` modifier counts too. Overloads
  make one candidate.
- Calls and low-level calls made inside library and free functions the
  contract runs are reported (`SignatureChecker`'s `staticcall`, OpenZeppelin's
  `Address` calls).
- The `from libraries:` line keeps `writes storage in assembly`.
- The candidate for a call into another contract no longer says its address is
  set at deployment or by an admin: it may be given by the caller.
- A contract that another reported contract inherits says so
  (`inherited by:`), and two contracts of one name no longer share candidate
  ids.
- `vibloom init` in a folder with no source folder and no tests says so and
  how to run it at the project root.

## 0.6.0

### Changed

- `vibloom survey` reads each contract with everything it inherits, across
  files: imported files are loaded, bases are resolved by name through the
  imports and linearized as the compiler does, and internal calls dispatch to
  the most derived override. Inherited functions carry their own gates and
  caller checks: from the project's own files one line each with
  `(from Base)`, from library files on one `from libraries:` line. The list
  of inherited function names that were assumed to be gated upstream is gone.
- A modifier from another file is a gate by its code, following the caller
  into the parameters it is passed (`onlyRole` -> `_checkRole`); its name only
  decides when its code was not found.
- A check that only turns some callers away (`require(!blacklisted[msg.sender])`)
  is no longer a caller check. An early `return` for the caller followed by a
  revert, and a modifier that runs the function only for some callers, are.
- State lines say `set at deployment` when a constructor or an initial value
  sets the variable; namespaced storage of the project is shown as
  `Struct.field`. Writes through a library's `storage` parameter are seen.
- Calls and low-level calls come from every contract inherited, each with its
  own `file:line`; library calls on a contract (`SafeERC20.safeTransfer(token,
...)`) count as calls to it, and assembly `call`, `delegatecall` and
  `staticcall` are reported. A function whose code writes storage in assembly
  is flagged.
- The "who decides who passes" candidate works across files, so the
  name-based `role-admin` and `owner-transfer` candidates only appear when the
  code did not show who writes the roles or the owner. Low-level calls of one
  kind make one candidate.
- Functions of the ABI that the source did not explain (a base whose source
  was not found) are listed under `not resolved`, with the missing bases.
- `vibloom gaps` lists inherited functions of the project's own bases with the
  contract's own; `inherited:` now means library code.

### Fixed

- The configured `src` and `out` folders are read when `forge config --json`
  prints its JSON over several lines.

## 0.5.1

### Fixed

- `forge` is found in `~/.foundry/bin` when the PATH of the process lacks it,
  as happens when an editor starts the MCP server or the hooks on Windows.

## 0.5.0

### Added

- `vibloom survey [--propose]`, for Foundry projects: from the compiler's
  syntax trees, who may call each state-changing function, the other
  modifiers, state variables and the functions that write them, the upgrade
  gate, calls into other contracts and low-level calls, then assumption and
  invariant candidates. `--propose` files the assumptions as proposals with
  the `file:line` they come from and a suggested node id. Test code is left
  out. A function with no gate that checks the caller in its body is reported
  as `anyone, checks the caller at :LINE`; `fallback` and `receive` are entry
  points; calls with `{value: ...}` are seen; for a gate that reads the
  contract's own state, a candidate says which functions decide who passes it.
- `vibloom research` and the `research` tool: the brief an agent works from,
  made of the person's notes in `.vibloom/notes.md`, the survey and how to
  work (read docs, audits and standards; read the chain only with read-only
  `cast` at a fixed block; propose each finding with evidence).
- Nodes and proposals carry an `evidence` list. The `propose` tool requires it
  and takes an optional `id`; `vibloom add --evidence`.
- `vibloom edit <id>` and `vibloom remove <id>` (verifier only). `remove` is
  refused while other nodes rest on the node.
- `vibloom proposals accept` and `reject` take several ids; the list shows
  each proposal's test and where it comes from.
- The pre-tool hook denies the builder commands that sign or send a
  transaction: `cast send|publish|mktx|wallet`, `forge create`,
  `forge script ... --broadcast` and any `--private-key`, `--mnemonic`,
  `--ledger`, `--trezor` or `--keystore` flag.
- `vibloom gaps` first lists contracts no test file names at all, then
  functions (own and inherited) no test names, then handler functions whose
  every call reverted.

### Changed

- `vibloom context [path]` is shorter: full detail only for nodes that name
  the file, one line for nodes that only watch its folder or are connected,
  the reason for trouble elsewhere, and a count of the rest.
- `vibloom status` starts with "N nodes, K need attention." and lists troubled
  rows first.
- `vibloom init` installs the commit check on its own only when the project is
  the repository root; in a folder of a larger repository it prints a hint
  (`vibloom install-hook`). The installed hook changes into the project folder
  first, and `vibloom precommit` passes when the commit stages nothing of the
  project.

### Fixed

- Output piped to a reader that stops early (`| head`) exits quietly.
- For Foundry projects whose tests live inside the source folder (dapptools
  layout, `src/test/*.t.sol`), `init` finds the tests folder from forge's own
  test list.

## 0.4.0

### Added

- `vibloom gaps` (and the `gaps` tool), for Foundry projects: the
  state-changing functions of the project's contracts that no test file
  names, and the handler functions whose every call reverted in the latest
  run. The second also shows under each invariant in `context`.

## 0.3.0

### Fixed

- An invariant that passed while every call the fuzzer made reverted (or
  while it made none) read as holding. It is now VACUOUS and fails the check.
- The overview an agent reads listed a troubled node without saying why.

### Added

- `init --agent claude|codex` and `setup claude|codex` connect an agent in one
  step: hooks and tools for Claude Code, an `AGENTS.md` section for Codex.
  The agent's settings files are guarded. `init` also installs the commit
  check.
- The fuzz campaign behind each invariant (runs, calls, reverts) is recorded
  and shown in `context` and `status --json`.

### Changed

- Less for an agent to read: the note after an edit to a watched file is
  given once per file between runs, the `run` tool returns only what needs
  attention, and a watched test file is not listed twice.

## 0.2.0

The first release. Since the first Rust version:

### Fixed

- A test that never ran, was skipped, or was missing from the latest run of
  the whole suite no longer reads as fine: `check`, `status`, the commit check
  and the hooks all treat it as needing attention. A mistyped test name or a
  deleted invariant could pass before.
- Runs recorded at the same time (two agents, a hook and a person) broke the
  log's chain for good. They are now chained under a lock.
- An agent could accept its own proposal. Deciding a proposal, `scan` and
  `add` now need the verifier role.
- Files a project ignores (build output, caches) inside a watched folder made
  a node pending right after a clean run. A watched folder now holds what git
  tracks or would track.
- A mistyped key in the map was ignored; it is now an error.
- An unknown option to `run` was handed to the test runner and recorded a
  failed run. Runner arguments go after `--`.
- On macOS, a new file in a new folder was taken to be outside the project.
- Foundry 1.9 runs a contract's invariants as one campaign and reports them
  under one name; each invariant is now read from it. A status the guard does
  not know is recorded as a failure, never dropped.

### Added

- JUnit XML reports, for cargo-nextest, pytest, Jest, mocha (Hardhat) and Go.
- `init` detects Foundry, Hardhat, Cargo or pytest. For Foundry it lists the
  tests with forge, so inherited invariants are found, and guards the handlers
  and base contracts the invariant tests import, and `foundry.toml`.
- `add`, `install-hook`, `sync --base`, `repair`, `status --json`,
  `--version`.
- A time limit for a run (`"timeout"` in the map, 3600 s by default).
- The Claude Code hook recognises the project's own runner, not only
  `forge test`, and denies commands that set `VIBLOOM_ROLE`, commit with
  `--no-verify` or restore a guarded file through git.
- Binaries for Linux (x86_64, arm64), macOS (arm64, x86_64) and Windows.
