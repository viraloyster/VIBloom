# VIBloom for code

The reference for `vibloom` (`crates/vibloom`, one Rust binary). New here?
[quickstart.md](quickstart.md) is the path from nothing to a useful map; this
page is for when you need the detail. Sections follow the order you are likely
to need them.

`vibloom` keeps a map of what a project assumes, what must always hold and
what each part is for, records every test run in a local log and derives from
those runs whether each node still stands. An agent reads the map and
proposes; it never sets a state. It reads Foundry (`forge test --json`),
any runner that writes JUnit XML (cargo-nextest, pytest, Jest, mocha
(Hardhat), Go and most others) and the reports of Halmos and Echidna, and
it says what kind of guarantee each result gives. No model is involved and it depends on no
particular agent: Claude Code, Codex, Cursor, Aider or a person editing by
hand all go through the same map, rules and commit check.

## Install

Download the binary for your platform from the
[releases](https://github.com/viraloyster/VIBloom/releases) (Linux x86_64
and arm64, macOS arm64 and x86_64, Windows x86_64) and check it against its
`.sha256` file. The binaries are not code-signed yet. Or build it:

```bash
cargo install --locked --git https://github.com/viraloyster/VIBloom vibloom
```

One binary, no runtime to install. A hook call takes about 2 ms. From this
repository: `cargo run -p vibloom -- <command>`.

A release is made by raising `version` in `crates/vibloom/Cargo.toml` and
either pushing a tag `guard-v<version>` or running the Release guard workflow
by hand with "publish" on, which tags the commit itself. The workflow builds
and tests every platform first; run by hand without "publish", that is all it
does.

## Start

In the project's root:

```bash
vibloom init      # or: vibloom init --agent claude (or codex, or both)
vibloom check     # run the tests and decide from that run
vibloom           # where things stand and the one next step
```

`init` detects Foundry, Hardhat, Cargo or pytest (`--stack` to choose), writes
the map, installs the commit check in this clone's git hooks and, with
`--agent`, connects that agent. It ends with the next step for the state it
left: `vibloom check` when it found invariant tests or, when it found none,
where to start (`vibloom survey` for Foundry, and a test template). It
installs the commit check on its own only when the project is the repository
root; in a folder of a larger repository it prints a hint, and
`vibloom install-hook` adds the check when you want it. The installed hook
changes into the project folder first, and `vibloom precommit` passes when a
commit stages nothing of the project. An existing pre-commit hook of another
tool is never overwritten: `install-hook` prints the line to add to it. If
`vibloom` is not on `PATH`, the hook refuses the commit and says so.

- `--agent claude` adds the hooks to `.claude/settings.json` and the tools to
  `.mcp.json`, keeping what those files already hold, sets
  `"env": {"VIBLOOM_ROLE": "builder"}` in both (see [Who decides](#who-decides)),
  and guards both files (and `.claude/settings.local.json`) so the agent
  cannot switch the guard off.
- `--agent codex` adds a short section to `AGENTS.md`, guards that file so a
  builder cannot commit a rewrite of the guard's instructions, and prints the
  one command that registers the tools. Codex has no hooks that can stop an
  edit while it works, so there the commit check and CI are what hold.

On a project that already has a map, `vibloom setup claude` (or `codex`) does
the same, and `vibloom install-hook` installs the commit check in another
clone.

For a Foundry project `init` asks forge for its tests (`forge test --list`), so
an invariant inherited from a base contract is found under the contract it
runs in, and tests kept inside the source folder (the dapptools layout,
`src/test/*.t.sol`) are found too. Each invariant found becomes a protected
node. `init` also guards what the invariants lean on: the handlers and base
contracts their test files import, and `foundry.toml`, where the fuzz and
invariant runs and depth are set. Weakening a handler or lowering `runs`
weakens an invariant without touching its test, so only the person may.

What a test imports is read from forge itself: `init` runs `forge build --ast`
and follows each invariant test's `ImportDirective.absolutePath` in the
compiler's syntax trees, where remappings are resolved. Of the files reached,
test code (handlers, bases, mocks) goes to `protect`, and every project file
reached becomes that invariant's `watch`; library files (`lib/`,
`node_modules/`) are left out. When the syntax trees are not there (forge
missing or failing, another runner), `init` reads relative imports from the
source text and each invariant watches the source and test folders. `init`
and `scan` say which of the two they used.

`vibloom scan` adds invariant tests the map does not list yet. It never
rewrites what an existing node watches on its own: it lists the invariants
whose watch it would narrow to their import closure, and `scan --tighten` does
it. Only a watch that holds whole folders is narrowed; files listed by hand
stay.

## Who decides

The map says what counts as proof, so whoever is judged by it must not be
able to change it. There are two roles:

- **The verifier** changes the map: `add`, `edit`, `remove`, `scan`, `setup`,
  `repair`, deciding proposals, editing protected tests and committing
  guarded files. A person at a terminal is the verifier with no
  configuration.
- **The builder** writes code, runs the tests and proposes. An AI agent is the
  builder.

The role is resolved in this order:

1. `VIBLOOM_ROLE`, when set: `verifier`, or `builder` (any other value is the
   builder).
2. Otherwise the builder when the command runs inside an agent, known by the
   variables the agent tools set for the commands they run: `CLAUDECODE`
   (Claude Code), `CODEX_THREAD_ID` and `CODEX_SANDBOX` (Codex CLI),
   `CURSOR_AGENT` (Cursor's agent) and `GEMINI_CLI` (Gemini CLI).
3. Otherwise the verifier.

The MCP server (`vibloom mcp`) always acts for an agent: it has no tool that
changes the map, whatever its environment says. `vibloom init --agent claude`
and `setup claude` write `VIBLOOM_ROLE=builder` into `.claude/settings.json`
and into the `.mcp.json` server entry, so in Claude Code the role does not
rest on detection. The Claude Code pre-tool hook denies the builder any
command that mentions `VIBLOOM_ROLE` or the detection variables, or that
clears the environment (`env -i`, `env -u`).

A command refused for the role says why and how the person does it:

```
$ CLAUDECODE=1 vibloom edit inv.assets-match-flows --stance off
This changes the map, which is a decision for the person, not for the agent writing the code: whoever is judged by the checks must not be able to change them.
vibloom treats this command as an agent's (CLAUDECODE is set: Claude Code is running this command).
The person runs it in their own terminal: vibloom edit inv.assets-match-flows --stance off
```

This is a convention for honest agents and a speed bump for the rest, not a
lock: an agent that controls its machine can unset a variable or start a
shell without it. The enforcement is on the server: `vibloom check --base` in
CI, code owners and branch protection ([Where the rules are
enforced](#where-the-rules-are-enforced)). A person whose own terminal looks
like an agent's (a shell opened from inside an agent tool) runs the command
with `VIBLOOM_ROLE=verifier`.

## The map

`.vibloom/roots.json`, written by people and kept in git. Its format is
published as a JSON Schema and described for other tools in
[format.md](format.md). From `examples/foundry-vault` after the
[quickstart](quickstart.md), one of its two invariants left out:

```json
{
  "$schema": "https://raw.githubusercontent.com/viraloyster/VIBloom/main/schema/roots.v1.schema.json",
  "version": 1,
  "runner": ["forge", "test", "--json"],
  "tests": "test/",
  "protect": ["foundry.toml", "test/handlers/VaultHandler.sol"],
  "nodes": [
    {
      "id": "inv.assets-match-flows",
      "kind": "invariant",
      "title": "invariant_assetsMatchFlows",
      "stance": "adopted",
      "test": {
        "file": "test/Vault.t.sol",
        "contract": "VaultTest",
        "name": "invariant_assetsMatchFlows"
      },
      "watch": ["src/Vault.sol", "test/handlers/VaultHandler.sol"],
      "depends_on": ["asm.the-handler-covers-every-way"],
      "protected": true
    },
    {
      "id": "int.nobody-can-take-out-more-than",
      "kind": "intention",
      "title": "Nobody can take out more than their shares are worth",
      "stance": "adopted",
      "depends_on": ["inv.assets-match-flows", "inv.shares-are-backed"],
      "protected": false
    },
    {
      "id": "asm.the-handler-covers-every-way",
      "kind": "assumption",
      "title": "The handler covers every way assets enter or leave the vault",
      "stance": "hypothetical",
      "protected": false
    }
  ]
}
```

- **invariant**: a property that must always hold, tied to a test. Protected by
  default: only the verifier edits its test.
- **assumption**: something taken as given that no test of yours proves.
  `hypothetical` until someone adopts it, `adopted` or `off`.
- **intention**: what a contract or a change is for.
- `depends_on`: **this node rests on these: if one of them fails, this is at
  risk.** `--on` on the command line writes it, and it is the one direction
  used everywhere: an invariant or intention rests on the assumptions it
  needs, and an intention rests on the invariants that make it true. An
  assumption does not rest on the test that shows it; that is `evidence`. The
  links form a DAG; a cycle or an unknown id is rejected.
- `watch` lists files, or directories ending in `/`, that the node is about.
  For a node with a test, a change to one puts the node pending review until
  the tests run again; its test file is always watched. A node without a test
  has no run to compare with, so a change never changes its state: `vibloom
context <file>` and the hook after an edit name it for a person to re-read.
- `evidence` lists where the node comes from: `file:line`, a URL with its
  section, or a chain read with its block. `context` and `proposals` show it
  as `from:`.
- `accepts` lists dependencies that are off and that the node accepts as
  risks, each with its reason (see [Accepted risks](#accepted-risks)).
- `protect` lists further paths only the verifier may change: test
  configuration, handlers, the agents' own files.
- `strict` (false when not given) counts unreviewed nodes as needing
  attention (see [Not yet reviewed](#not-yet-reviewed)).
- `ignore_failures` lists globs (`*` and `?`) on `Contract.test` or on a
  test's file; failing tests no node rests on that match one do not fail the
  check (see [A red suite is red](#a-red-suite-is-red)).
- `runner`, `report`, `tests` and `timeout`: see [Runners](#runners);
  `checks`, and a test's `tool`: see [Other tools](#other-tools-halmos-echidna-a-second-junit-runner).
- `$schema` names the schema for editors; `init` writes it first.

The map is checked strictly: an unknown key, such as a mistyped `watch`, is an
error, not something ignored.

## Adding and changing nodes

Each command prints the id it created or changed; an id is the kind's prefix
and the title, cut between words within 32 characters. An id that does not
exist, anywhere one is taken, is answered with the nearest ones (`No node
inv.assets-match-flow. Did you mean inv.assets-match-flows?`).

```bash
vibloom add "Rounding in withdraw always favours the vault"
vibloom edit inv.shares-are-backed --on asm.rounding-in-withdraw-always
vibloom add intention "Nobody can take out more than their shares are worth" --on inv.assets-match-flows --on inv.shares-are-backed
vibloom add invariant "Shares never exist without assets" --file test/Vault.t.sol --contract VaultTest --test invariant_sharesAreBacked
```

`add` with no kind adds an assumption. `--watch` (repeatable) sets what a node
watches; a node added with a test watches the source and test folders when
none is given. `--evidence` (repeatable) records where it comes from,
`--detail` adds a longer text, `--id` picks the id, and `--unprotected` leaves
an invariant's test editable by the builder. An assumption starts
`hypothetical`, invariants and intentions `adopted`: the same rule for `add`,
for a node written in the map without a stance and for an accepted proposal.
`--adopted` and `--hypothetical` choose. `add` says which stance the node got.

```bash
vibloom edit asm.rounding-in-withdraw-always --stance adopted --evidence "src/Vault.sol:23"
vibloom remove inv.shares-never-exist-without
```

`edit` takes `--title`, `--detail`, `--stance`, `--on` and `--not-on`,
`--watch` and `--unwatch`, `--evidence` and `--drop-evidence`, `--accept`
with `--reason` and `--unaccept` (at least one; an empty `--detail` clears
it); the result must still be a valid map. `remove` is refused while other
nodes rest on the node: point them elsewhere first, or switch it off with
`edit --stance off`. Its recorded runs stay in the local log.

### Not yet reviewed

A `hypothetical` node is one nobody has decided yet. It does not make the
check fail by default (a real map holds many hypotheses, and a check that is
always red stops being read), but it is never out of sight:

- the summary line counts them: `5 nodes, 2 need attention, 1 not yet reviewed.`;
- a node that rests on hypothetical nodes, directly or through others, says so
  in its state, `holds (rests on 1 unreviewed)`; a hypothetical node with a
  test of its own shows `holds (unreviewed)`;
- `status` and `check` end with a `Not yet reviewed` section listing each one
  with the command that decides it: `vibloom edit <id> --stance adopted`, or
  `--stance off`.

`status --strict` and `check --strict`, or `"strict": true` in the map, count
every hypothetical node, and every node resting on one, as needing attention.
The commit check and the agent hooks ignore strict: only the verifier can
adopt a node, so a builder held back by it could do nothing about it.

### Accepted risks

An assumption switched `off` is one the project knows does not hold, and
everything resting on it is unsupported or at risk. When that weakness is
known and acceptable, the verifier says so on the node that rests on it:

```bash
vibloom edit asm.rounding-in-withdraw-always --stance off
vibloom edit inv.shares-are-backed --accept asm.rounding-in-withdraw-always --reason "dust only; capped by the minimum deposit"
vibloom edit inv.shares-are-backed --unaccept asm.rounding-in-withdraw-always
```

The id must be one of the node's `depends_on`, the reason is required, and
`--accept` is refused for a dependency that is not off. While the dependency
is off it no longer makes the node troubled, and the node shows it,
`holds (accepts 1 risk)`. It is never hidden: `status` ends with an
`Accepted risks:` section, `status --json` carries them under
`accepted_risks`, and `context` gives the reason wherever it shows the node
in full. If the dependency is switched back on, the acceptance has no effect
and `status` says it can be removed. The MCP `propose` tool refuses it.

## Derived states

| State          | When                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| holds          | the latest run of its test passed, and no watched file changed since                                                                        |
| BROKEN         | the latest run of its test failed                                                                                                           |
| pending review | it passed, but a watched file changed since; its tool did not finish or its report is older than the code; or something below it is pending |
| UNSUPPORTED    | something it rests on is broken, off or unsupported                                                                                         |
| AT RISK        | the same, for an intention                                                                                                                  |
| untested       | its test has never run                                                                                                                      |
| skipped        | the latest run skipped its test                                                                                                             |
| MISSING        | its test ran once, but the latest run of the whole suite did not include it                                                                 |
| VACUOUS        | its invariant passed, but every call the fuzzer made reverted, or it made none; or Halmos found every path reverted                         |
| TEST CHANGED   | its protected test, or a guarded file the test leans on, differs from HEAD                                                                  |
| off            | switched off by a person; a choice, not a problem                                                                                           |

Every state but holds and off needs attention: `status`, `run` and `check`
exit 1, the commit check refuses and the agent is sent back. A node with no
test of its own shows its stance, adopted or hypothetical, while what it rests
on is sound. A test that never ran, was skipped or went missing is not
evidence, so a mistyped test name or a deleted invariant can never read as
passing.

A failure stays a failure until a newer run passes. A pass only counts while
the files it ran against are unchanged: each run records, for each node with a
test, one digest of the files it watches at the start of the run. A file
added to a watched directory, removed or edited changes the digest. In a git
repository a watched directory holds what git tracks or would track there, so
build output the project ignores never counts.

TEST CHANGED is read from git, so it covers a change made by any route: a
protected node's test file, the guarded handlers and base contracts it
imports, and the test configuration in `protect` (`foundry.toml`; the agents'
own files such as `AGENTS.md` do not count), modified, deleted or taken out of
git in the working tree or the index. It clears only when the change is
committed, and the commit check refuses a builder's commit of guarded files.
A protected test that was never committed is not changed. Outside a git
repository, or before the first commit, nothing is compared.

The whole suite is the map's `runner` with no extra arguments. A filtered run
(`vibloom run -- --mt X`) records what it ran and says nothing about the rest.

### A red suite is red

`check` exits 1 when any test in its run failed, whether or not a node rests
on it, and names the failing tests no node rests on:

```
Run 2: 3 test results recorded, 2 failed.
1 failing test no node rests on, which still fails the check: VaultTest.test_depositThenWithdrawReturnsEverything.
Fix it, or tie it to a node; a test known to be red can be listed in "ignore_failures" in the map.
```

Otherwise an approved guard change that guts the invariants could pass while
a plain unit test catches the bug. For a project with known-red legacy tests
there is one escape, in the map, so only the verifier sets it and
`check --base` reports a new pattern as a guard change: `"ignore_failures"`.
In Maker's dss, built with today's forge, the 54 dapptools-style `testFail`
tests fail:

```json
{ "ignore_failures": ["*.testFail*"] }
```

`check` then says `Ignoring 54 failing tests by rule (ignore_failures in the
map).` and passes, and `status` keeps a line for it for as long as the rule is
there: `Ignoring 54 failing tests by rule (in the latest run; ignore_failures:
*.testFail*).` The JSON carries both lists under `failures`. `run` prints the
same lines and keeps its exit to the nodes.

## Commands

`vibloom help` lists them in two tiers. Everyday:

```bash
vibloom                       # where things stand and the one next step
vibloom init [--stack S] [--agent claude|codex]
vibloom check [--base ref [--allow-guard-changes]] [--strict] [--json | --format github] [-- args]
vibloom status [--json] [--strict]
vibloom add [assumption|invariant|intention] "<title>" [--on ID]... [--file F --test N [--contract C] [--tool T]] [--watch P]... [--evidence E]... [--detail D] [--id ID] [--hypothetical | --adopted] [--unprotected]
vibloom proposals [<id> | --full] [--contract C]
vibloom proposals accept <id>... | --all [--contract C] [--on ID]...
vibloom proposals reject <id>... | --all [--contract C]
vibloom survey [<Contract>...] [--propose]
```

More:

```bash
vibloom edit <id> [--title T] [--detail D] [--stance S] [--on ID] [--not-on ID] [--watch P] [--unwatch P] [--evidence E] [--drop-evidence E] [--accept ID --reason R] [--unaccept ID]
vibloom remove <id>
vibloom scan [--tighten]
vibloom setup claude|codex
vibloom context [file]        # what an agent should know before touching a file
vibloom research              # the brief an agent works from
vibloom gaps                  # Foundry: contracts and functions no test names
vibloom run [-- args]         # run the tests, record the run, show what changed
vibloom mcp                   # serve the map to any MCP client over stdio
vibloom hooks                 # print the Claude Code hooks configuration
vibloom hook pre-tool|post-tool|stop
vibloom install-hook          # install the commit check in this clone
vibloom precommit             # the commit check itself
vibloom diff <ref> [--json]   # what is gone, weakened or changed under the map since <ref>
vibloom verify                # check the local log's hash chain
vibloom repair                # set aside everything after a broken link
```

`status`, `run` and `check` print `N nodes, K need attention, M not yet
reviewed.` and then the nodes, those needing attention first, and `run` and
`check` list what changed state before the table. Output piped to a reader
that stops early (`| head`) exits quietly. A mistyped command gets the
nearest ones (`No command stauts. Did you mean status?`). `vibloom sync` is
gone (the log no longer travels with the branch); run it and it says so.

### Exit codes

Every command but the hooks:

| Exit | Meaning                                                                                                                                                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | nothing needs attention                                                                                                                                                            |
| 1    | a verdict: a node needs attention, a test failed (`check`), a guard change was not approved, the commit check refused, `verify` found a broken chain                               |
| 2    | vibloom could not do its job: no map or an unreadable one, bad arguments, a git error, a role refused, a damaged local log, the runner did not start, timed out or wrote no report |

`vibloom` with no arguments and `vibloom help` exit 0. `vibloom hook ...`
keeps the agent's hook protocol: it exits 0 with its answer in JSON, and 1
when it fails, never 2 (which Claude Code reads as "block").

### JSON

`status --json` and `check --json` (or `check --format json`) print one
object, also when the exit is 2. From `examples/foundry-vault` with the
vault's books broken, two of its five nodes shown:

```json
{
  "accepted_risks": [],
  "exit": 1,
  "failures": {
    "failed": 2,
    "ignored": [],
    "untracked": ["VaultTest.test_depositThenWithdrawReturnsEverything"]
  },
  "format": 1,
  "guard": null,
  "ignore_failures": [],
  "log_problems": [],
  "nodes": [
    {
      "changed": [],
      "files": ["test/Vault.t.sol", "src/Vault.sol", "test/handlers/VaultHandler.sol"],
      "fuzz": { "calls": 2048, "reverts": 204, "runs": 64 },
      "how": { "depth": 32, "kind": "fuzzed", "loop": null, "runs": 64, "shown": "fuzzed 64x32" },
      "id": "inv.shares-are-backed",
      "kind": "invariant",
      "needs_attention": false,
      "reason": null,
      "rests_on_unreviewed": ["asm.rounding-in-withdraw-always"],
      "run": 5,
      "shown": "holds, fuzzed 64x32 (rests on 1 unreviewed)",
      "stance": "adopted",
      "state": "holds",
      "title": "invariant_sharesAreBacked",
      "troubled": false
    },
    {
      "changed": [],
      "files": [],
      "fuzz": null,
      "how": null,
      "id": "int.nobody-can-take-out-more-than",
      "kind": "intention",
      "needs_attention": true,
      "reason": "because of inv.assets-match-flows",
      "rests_on_unreviewed": ["asm.rounding-in-withdraw-always"],
      "run": null,
      "shown": "AT RISK (rests on 1 unreviewed)",
      "stance": "adopted",
      "state": "AT RISK",
      "title": "Nobody can take out more than their shares are worth",
      "troubled": true
    }
  ],
  "not_yet_reviewed": [
    {
      "adopt": "vibloom edit asm.rounding-in-withdraw-always --stance adopted",
      "id": "asm.rounding-in-withdraw-always",
      "switch_off": "vibloom edit asm.rounding-in-withdraw-always --stance off",
      "title": "Rounding in withdraw always favours the vault"
    }
  ],
  "run": { "command": ["forge", "test", "--json"], "error": null, "seq": 5 },
  "summary": {
    "accepted_risks": 0,
    "need_attention": 2,
    "nodes": 5,
    "not_yet_reviewed": 1,
    "strict": false
  },
  "tool_error": null
}
```

- `state` is the plain label of the table above; `shown` adds what the table
  shows after it: the kind of guarantee (`fuzzed 64x32`) and the notes
  (`accepts 1 risk`, `rests on 2 unreviewed`, `unreviewed`).
- `how` is the kind of guarantee the node's test gives: `kind` (`unit`,
  `fuzzed`, `symbolic`), `runs` and `depth` (calls per run) when known,
  `loop` for a bounded symbolic run when the command sets it, and `shown`.
  Null for a node without a test, and for a runner's test that never ran.
- `troubled` is the node's own trouble; `needs_attention` is what counts,
  with `strict` applied.
- `reason` is one line, or null; `files` lists the node's test first, then
  what it watches; `changed` the watched files that changed since its run.
- `failures` covers the run (`check`) or the latest recorded one (`status`;
  null before any run): how many tests failed, the failing tests no node
  rests on (`untracked`, which fail `check`) and those `ignore_failures`
  lets through (`ignored`).
- `guard` is null without `--base`; with it, it holds `base`,
  `base_has_map`, `allowed` and `changes`, where each change has a `kind`
  (`file_changed`, `file_removed`, `file_added`, `node_removed`,
  `test_changed`, `test_removed`, `unprotected`, `switched_off`,
  `accepts_added`, `dependency_removed`, `runner_changed`, `report_changed`,
  `timeout_changed`, `tests_changed`, `protect_removed`,
  `ignore_failures_added`, `strict_off`, `check_removed`, `check_changed`), a
  `path`, a `node` when it is about one, and a `message`.
- `run` is null for `status`. `tool_error` is null unless the exit is 2.
  Every accepted risk is `{ "node", "dependency", "reason", "in_effect" }`.

New keys may be added; the ones above keep their meaning while `format` is 1.
The shape is published as [`schema/status.v1.schema.json`](../schema/status.v1.schema.json).

`check --format github` prints the usual text and, after it, GitHub Actions
workflow commands: `::error` for each node that needs attention (on its test
file, at the line the test is defined on) and each guard change not approved,
and `::warning` for each unreviewed node and each approved guard change.

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
  with `vibloom add invariant ... --file F --test N`.
- `"timeout"` in the map is the number of seconds a run may take (3600 when
  not given). A run that does not finish is stopped and recorded as an error.

### Other tools: Halmos, Echidna, a second JUnit runner

The `runner` is the project's own test command. Results of other tools enter
through `checks`, each `{ "tool", "report", "command"? }`, and a node reads
one with `"tool"` in its test:

```json
{
  "checks": [
    {
      "tool": "halmos",
      "report": "halmos-report.json",
      "command": ["halmos", "--loop", "2", "--json-output", "halmos-report.json"]
    },
    {
      "tool": "echidna",
      "report": "echidna.json",
      "command": [
        "sh",
        "-c",
        "echidna . --contract VaultEchidna --config echidna.yaml --format json > echidna.json"
      ]
    }
  ]
}
```

```bash
vibloom add invariant "Withdraw takes out exactly the assets it pays" --file test/VaultSym.t.sol --contract VaultSymTest --test check_withdrawTakesAssetsOut --tool halmos --watch src/Vault.sol
```

- With `command`, `check` and `run` delete the report, run the command after
  the runner, with the same `timeout`, and read the report. A tool that finds
  a counterexample exits non-zero; the report says so. A command that writes
  no report is an error (exit 2), with what it printed last.
- Without `command`, a report someone ran by hand counts only while it is
  newer than every file the nodes reading it watch. Missing or older, those
  nodes are pending review and say why; a stale report is never trusted.
- Checks run with a run of the whole suite only: a filtered run
  (`vibloom run -- --mt X`) says nothing about them.
- Halmos (`--json-output`): PASS holds; COUNTEREXAMPLE is BROKEN with the
  model in the reason; REVERT_ALL is VACUOUS; TIMEOUT, STUCK and EXCEPTION
  are pending review with "halmos did not finish". Halmos reads forge's build
  output with its syntax trees; set `ast = true` in `foundry.toml`, or the
  build `forge test` leaves behind has none and Halmos finds no tests.
- Echidna (`--format json`, written to the report by the command): passed and
  verified hold; solved is BROKEN with the reproducing calls; fuzzing,
  shrinking and error are pending review with "echidna did not finish".
  This reader was written from Echidna's documented output and has not yet
  been checked against a real campaign; the Halmos one was.
- `junit`: a second runner's JUnit XML, read like `report`.
- Medusa is not supported: it writes no machine-readable test results (only
  coverage and revert reports, and an exit code), and its log is no format.

`init` and `scan` guard the tools' configuration as they guard
`foundry.toml`: `halmos.toml` and any `.yaml`, `.yml` or `.toml` file a
check's command names go to `protect` when they exist. Removing a check or
changing its command or report is a guard change for `check --base`.

### What each kind of guarantee establishes

`status` shows the kind next to every state (`holds, fuzzed 64x32`,
`holds, symbolic (bounded, loop 2)`, `BROKEN, unit`), and the JSON carries it
as `how`. A result is never shown as a stronger kind than its tool gives.

| Kind                 | Establishes                                                                | Does not establish                                                                  |
| -------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `unit`               | the property for the inputs the test wrote down                            | anything about other inputs or call orders                                          |
| `fuzzed`             | no counterexample in the runs and calls made (runs x calls per run, shown) | that none exists; inputs the fuzzer did not reach, deeper sequences, other targets  |
| `symbolic (bounded)` | no counterexample for any input, within the loop and depth bounds          | anything past those bounds, past the solver's timeouts, or outside the test's setup |

A failure is a failure whatever the kind: one counterexample is enough.

## For smart contracts

What a test suite proves is only as good as what it was asked. The map is
where that is written down:

- **Invariants**: what must hold after any sequence of calls. The ones that
  matter are usually about accounting (assets equal the sum of what entered
  minus what left), solvency (what can be claimed never exceeds what is
  held), access (only a role can move a parameter) and monotonic quantities (a
  nonce, a share price that never falls on deposit). Each is a node tied to
  its `invariant_` test. A template is in
  [the quickstart](quickstart.md#an-invariant-test).
- **Assumptions**: what the code takes as given: the token is a standard
  ERC-20 (no fee on transfer, no rebase), the oracle is fresh and correct, the
  admin key is safe, rounding always favours the protocol, the handler covers
  every entry point. The invariants that need one rest on it
  (`vibloom edit <invariant> --on <assumption>`); when it is switched off or
  contradicted, they show as unsupported.
- **Intentions**: what a contract or a change is for ("nobody can take out
  more than their shares are worth"), resting on the invariants and
  assumptions that make it true. An intention at risk is the plain-language
  answer to "what did this break?".

The guard also reads how hard each invariant was pushed. `vibloom context`
shows `fuzzed: 64 runs, 2048 calls, 0 reverted` under an invariant, and a
pass in which every call reverted (or none was made) is not a pass: the node
is VACUOUS and the check fails, because a handler that never gets a call
through tests nothing. With `fail_on_revert = false` that is the easiest way
for an invariant to go green without meaning it.

An invariant holding says nothing about code the fuzzer never reached.
`vibloom gaps` lists the ways that happens. In Maker's dss, with one
invariant test on the Vat (the list is cut short here):

```
State-changing functions no file under src/test/ names, so no test can reach them:
- Cat (src/cat.sol): claw
- Dai (src/dai.sol): pull
- Dog (src/dog.sol): digs
- Vat (src/vat.sol): nope
Handler functions whose every call reverted in the latest run:
- Vat.file
- Vat.flux
```

Contracts no test names at all are listed first, on their own. The names come
from the compiled contracts and the text of the test files: a name that
appears there may still not be exercised, but one that does not appear cannot
be. Each contract's functions are listed, its own and those of the project's
own base contracts, then the ones it takes from library code after
`inherited:`. The last part comes from the fuzzer's own counts. These are
reports, not failures: a function may be left out on purpose, and then an
assumption is the place to say so.

## From code and notes to a map

For a Foundry project the first draft of the map does not have to be written
from a blank page:

1. **Notes.** Write what the system is meant to guarantee, in your own words,
   in `.vibloom/notes.md`. Nothing reads it but the research brief below; an
   agent cannot edit it, and you commit it from your own terminal.
2. **Survey.** `vibloom survey` runs `forge build --ast` and reads the
   compiler's syntax trees: for each contract, who may call each
   state-changing function (the gates), the other modifiers, the state
   variables and which functions write them, what gates an upgrade, the calls
   into other contracts and the low-level calls; then assumption and
   invariant candidates, and the next step. `vibloom survey Vat Dog` prints
   only those contracts; a name that is not there gets the nearest ones and
   the list.
3. **Propose.** `vibloom survey --propose` files the assumption candidates as
   proposals, each with the `file:line` it comes from and a suggested id, and
   prints a summary instead of the report. On Maker's dss:

   ```
   Filed 79 proposals, all assumptions: Cat 5, Clipper 8, Cure 3, Dai 2, DaiJoin 4, Dog 5, End 12, ExponentialDecrease 2, Flapper 4, Flipper 4, Flopper 5, GemJoin 4, Jug 3, LinearDecrease 2, Pot 3, Spotter 4, StairstepExponentialDecrease 2, Vat 2, Vow 5.
   35 invariant candidates need a test before they can enter the map; `vibloom survey` lists them.
   See them: `vibloom proposals` (grouped by contract). Decide: `vibloom proposals accept <id>...` or `reject <id>...`, or a whole contract with `accept --all --contract <Name>`.
   ```

   A candidate already pending, in the map or rejected before is not filed
   again. Invariant candidates are only listed: an invariant needs a test.

4. **Decide.** `vibloom proposals` lists what is pending by contract (the
   `Contract:` that starts a survey title) and by kind, one line each:

   ```
   79 pending proposals (79 filed by `vibloom survey`). Nothing in them counts until you accept it.

   Cat (5)
     assumption
       p7   whoever passes auth is trusted with rely, deny and 3 more
       p8   rely, deny decide who passes auth (wards)
   ```

   `vibloom proposals p7` (or `--full` for all) shows a proposal with its
   detail and where it comes from. Then decide, by id or everything the
   listing shows:

   ```bash
   vibloom proposals accept p7 p8
   vibloom proposals accept --all --contract Vat
   vibloom proposals reject --all --contract Cure
   ```

   `--on <id>` (repeatable) makes every accepted node rest on that one. Every
   accept ends with how many nodes it created and that assumptions start
   hypothetical, not yet reviewed, until you adopt them.

5. **Research.** `vibloom research`, or the `research` tool over MCP, prints
   the brief an agent works from, kept short: the notes; the survey as one
   line per contract; each candidate's title once, with the contracts it
   applies to; and how to work. Before proposing anything about a contract
   the agent asks for its detail with the `survey` tool. The agent reads the
   project's docs, audits and the standards it implements; it reads the chain
   only with read-only `cast` commands (`cast code`, `call`, `storage`,
   `implementation`, `admin`, `logs`) using `ETH_RPC_URL`, at a fixed
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

### How the survey reads the code

Only files under Foundry's source folder are read as the project's own, and
only contracts are reported, not interfaces or libraries; an abstract
contract is reported only when no other contract of the project builds on it.
Functions are the state-changing ones in the compiled ABI (`nonpayable` and
`payable`), plus `fallback` and `receive`. Test code is left out: `*.t.sol`,
`*.s.sol`, the map's tests folder, Foundry's script folder and any folder
named `test`, `tests`, `mock` or `mocks`, in any case.

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

- A modifier on the function is its gate when its code checks the caller,
  itself or through what it calls, in any file. A caller passed as an argument
  stays the caller inside the function that receives it, so OpenZeppelin's
  `onlyRole(role)` -> `_checkRole(role, _msgSender())` is a gate by its code.
  Only a modifier whose code was not found is judged by its name (`only...`,
  `auth`, names with `role`, `owner`, `admin`).
- A function with no gate that checks the caller in its body is reported as
  `anyone, checks the caller at :LINE`; with a gate, the lines are added
  after the gate's name. A caller check is a `require` or `assert`, or an `if`
  that reverts, whose condition uses the caller (`msg.sender`, `tx.origin`,
  `_msgSender()` or a local alias of it) outside a `<` or `>` comparison and
  not only against the zero address. The caller compared with zero as the
  whole condition is a check (`require(msg.sender == address(0))`, a chain's
  own VM); a parameter the caller only passed on, tested against zero, is
  not. The caller handed to a call into another contract counts only when
  that call is `view` or `pure` (`require(token.hasRole(ROLE, msg.sender))`),
  since it then asks about the caller; a state-changing one
  (`require(gem.transferFrom(msg.sender, ...))`) asks the other contract to
  act, and is no check. An `if` that returns early followed by a revert
  counts, and so does a modifier that runs the function only for some callers
  (`if (msg.sender == admin) { _; }`). A check that only turns some callers
  away (`require(!blacklisted[msg.sender])`) trusts nobody and is not one. A
  call to code that checks the caller is reported at the line of the call
  (`upgradeToAndCall` calls the `_authorizeUpgrade` that the contract
  overrides).
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
- Calls with `{value: ...}` options are seen. For a gate whose check reads the
  contract's own state, the candidate says which functions decide who passes
  it.

Every fact the survey gives is read from the code, so it can be wrong about
what the code means but not invent a line that is not there. Nothing it files
counts until the verifier accepts it.

What the survey does not see:

- `selfdestruct` is not reported.
- Ether sent with `.transfer` or `.send` is not reported as a call.
- Storage written through inline assembly is flagged, but not tied to a state
  variable, so a slot a library defines and writes (`sstore` in a library
  function) never appears among a variable's writers.
- The lists of writers over-approximate: a function is listed when any path
  in its code can write the variable, whether or not it runs.
- `set at deployment` is said of an implementation behind a proxy too; the
  survey does not know a proxy's storage is not the implementation's.
- Where an address comes from (fixed, set by an admin, given by the caller) is
  not read, and neither is whether a hand-written initializer guard works.
- Anything outside the project's source folder, unverified or not compiled by
  `forge build --ast`, and the chain itself.

### Network and keys

`vibloom` itself never touches the network and stores no key (`forge` may
download a compiler when `survey` or `gaps` builds the project). The agent's
own `cast` reads use the `ETH_RPC_URL` of the person's environment. The
Claude Code pre-tool hook denies the commands that would send a transaction.

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
  installs its own). It refuses a builder's commit that changes a protected
  test, a path in `protect` or the map, a commit that leaves any node needing
  attention, and one made while the local run log fails verification. After
  changing code, run `vibloom run`; nothing of the log is committed.
- **CI**: `vibloom check --base` runs the tests, decides from that run alone
  and refuses guard changes nobody approved. See
  [Where the rules are enforced](#where-the-rules-are-enforced).

### Over MCP

`vibloom mcp` serves the map to any client that speaks the Model Context
Protocol over stdio (Claude Code, Codex, Cursor and others). Register it the
way the client registers a local server, with the project as the working
directory, for example `claude mcp add vibloom -- vibloom mcp`.

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

There is no tool to accept a proposal, set a state or edit the map. A
proposal waits in `.vibloom/proposals.jsonl` until the person runs
`vibloom proposals accept <id>` (or `reject <id>`), which checks it against
the map as it is and adds it.

### Optional: Claude Code

Claude Code can call the guard while it works instead of only at commit time.
`vibloom init --agent claude` (or `vibloom setup claude`) adds the hooks to the
project's `.claude/settings.json`; `vibloom hooks` prints them. They do three
things:

- **Before a tool runs**: an edit to a protected test, to a path in `protect`
  or to `.vibloom/` is denied to the builder. Shell commands that plainly
  write to those paths (redirection, `sed -i`, `mv`, `rm`, `cp`, `tee`,
  `git checkout`, `git restore`...) are denied too, and so are commands that
  mention `VIBLOOM_ROLE` or the detection variables, clear the environment,
  or commit with `--no-verify` (or `-n`). Commands that would sign or send a
  transaction are denied: `cast send`, `cast publish`, `cast mktx`,
  `cast wallet`, `forge create`, `forge script ... --broadcast` and any
  `--private-key`, `--mnemonic`, `--ledger`, `--trezor` or `--keystore` flag.
  Reads such as `cast call` pass.
- **After a tool runs**: after a command that runs the project's tests, the
  guard runs them itself and records that, so the agent's own output is never
  what counts. With Foundry it re-runs the same subset (`--match-test` and the
  other filters); with another runner, the whole suite. If anything needs
  attention, the agent is sent back with the list and the rule "fix the code,
  not the invariant". After an edit to a watched file, the agent is told
  which nodes are now pending review, and which watching nodes no test
  checks, once per file between runs.
- **Before the agent stops**: if any node needs attention, the agent is sent
  back once; Claude Code marks the second attempt, which the guard lets
  through so the session cannot loop. If the log fails verification, the
  agent is sent back every time, with the problems.

Other agents with a hook or plugin system can get the same behaviour by calling
`vibloom hook pre-tool`, `post-tool` and `stop` with the same JSON input, or by
calling `vibloom status` and `vibloom run` directly.

## Where the rules are enforced

Everything above runs on the machine where the code is written, and anything
that controls that machine can get around it: set or unset a variable, skip
the git hook, or write any local log it likes. The boundary an agent cannot
cross is on the server: a protected branch on GitHub that only accepts pull
requests that pass `vibloom check --base` and, for guarded files, a review by
their owner.

### The check on every pull request

`vibloom check --base <ref>` reads the map as it is on `<ref>`
(`git show <ref>:<project folder>/.vibloom/roots.json`, from git, never from
the pull request's working tree) and compares the guard with it before it
runs the tests:

- **The map.** A node removed, a node's test changed or removed, `protected`
  turned off, a stance set to `off`, an `accepts` added, a `depends_on` edge
  removed, an `ignore_failures` pattern added, `strict` turned off, the
  `runner`, `report`, `timeout` or `tests` changed, an entry taken out of
  `protect`, or a check removed or its command or report changed. Adding nodes, evidence, edges, `protect` entries or new
  protected tests is not a guard change.
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
hold, and any failing test fails it (see
[A red suite is red](#a-red-suite-is-red)). A reviewer approving guard
changes approves exactly what they read, which is why the approval belongs to
a person.

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

## After an audit

What the auditors reviewed is a commit. Tag it, hand them the map with the
code, and before each release compare what is there now with what they saw:

```bash
git tag audit-2026-11              # the commit the auditors reviewed
vibloom diff audit-2026-11         # before each release
```

`vibloom diff <ref>` reads the map and the files it guards at `<ref>` from git
and compares them with the working tree. It changes nothing and anyone may
run it. It lists the nodes that are gone or weakened (test changed or
removed, protection off, switched off, an accepted risk added, a dependency
removed), the guard changes (guarded files, runner, checks), the nodes still
the same in the map whose watched files changed (what the auditors saw is not
what is there now), the nodes added since, and one closing line with the
counts:

```
$ vibloom diff audit-2026-11
Guard changes since audit-2026-11:
- test/VaultSym.t.sol: guarded file changed
Not what was reviewed at audit-2026-11 (same node, but files it watches changed):
- inv.assets-match-flows: src/Vault.sol
- inv.withdraw-takes-out-exactly-the: src/Vault.sol, test/VaultSym.t.sol
- inv.shares-are-backed: src/Vault.sol
Since audit-2026-11: 0 gone or weakened, 1 guard change, 3 nodes with changed files, 0 added.
```

It exits 1 when anything but additions differs, 0 otherwise, and 2 when it
cannot compare. Long lists are cut to a screen; `--json` gives everything, in
the shape of [`schema/diff.v1.schema.json`](../schema/diff.v1.schema.json).

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
is damaged anyway, `vibloom repair` (the person's command) keeps the runs
before the break and moves the rest to `log.rejected-<time>.jsonl` beside it.

Because the log is local, a fresh clone has no states: every node with a test
is untested until `vibloom check` (or `run`) runs the tests there.

Upgrading from 0.7.0, a committed `.vibloom/log.jsonl` is moved aside into the
local folder (`log.committed.jsonl`) by the first command that finds it, and
never read. The command says once to take it out of git, which the person
does with `git rm --cached .vibloom/log.jsonl` and a commit.

## Limits

- The role comes from the environment: it separates honest agents, it does
  not authenticate them. Code owners, branch protection and `check --base`
  are the boundary that does.
- The Bash check is a heuristic on the command text, not a sandbox: a script
  that writes to a protected file indirectly is not caught while it runs. In a
  git repository the node then shows TEST CHANGED until the person commits
  the change, and `check --base` in CI refuses it as a guard change.
- The local log's hash chain has no key: it shows accidental damage, not
  forgery. Nothing that decides a pull request reads it.
- `check --base` compares the files the base guards, as the base's map names
  them. Its import graph for helpers is the relative imports in the text; the
  handlers `init` found through forge's trees are compared because they are in
  `protect`.
- Passing tests do not prove a global property. The guard knows only what the
  map says: it keeps the written assumptions and invariants from being skipped
  or weakened, and shows what is left unsupported when something changes. It
  does not discover a dependency nobody wrote down.
- `.vibloom/proposals.jsonl` is not hash-chained: it holds suggestions, not
  evidence, and nothing in it counts until a person accepts it into the map.
- The formats read are Foundry's JSON, JUnit XML, Halmos's `--json-output`
  and Echidna's `--format json`. A tool that writes none of them needs a
  parser that returns the same outcomes. The Echidna parser follows its
  documented output and has not yet been run against the real binary here.
- After a test command, the Claude Code hook re-runs that subset once more. On
  a large suite, filter with `--match-path` or `--match-test`.
