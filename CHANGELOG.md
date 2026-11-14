# Changelog

Changes to the `vibloom` binary. The web app is not versioned.

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
