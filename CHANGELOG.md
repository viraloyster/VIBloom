# Changelog

Changes to the `vibloom` binary. The web app is not versioned.

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
