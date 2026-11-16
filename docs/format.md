# The roots map format

This page is for authors of other tools that write or read a VIBloom map. You
do not need the Rust code to produce one or to consume what `vibloom` prints.

- The map: `.vibloom/roots.json` at the project root, kept in git, written by
  people. Schema: [`schema/roots.v1.schema.json`](../schema/roots.v1.schema.json).
- `vibloom status --json` and `vibloom check --json`:
  [`schema/status.v1.schema.json`](../schema/status.v1.schema.json).
- `vibloom diff <ref> --json`:
  [`schema/diff.v1.schema.json`](../schema/diff.v1.schema.json).

All three are JSON Schema draft 2020-12. A test in the crate keeps them equal
to what the code accepts and prints.

## Compatibility

- The map carries `"version": 1`. It is raised on any breaking change: a key
  removed or renamed, a meaning changed, a value that was valid becoming
  invalid. A new optional key does not raise it.
- `vibloom` rejects a map with a key it does not know, so a mistyped `watch`
  is an error, not a node that watches nothing. A tool that writes maps should
  write only the keys below.
- The JSON that `vibloom` prints carries `"format": 1`. New keys may appear
  while it is 1; a reader ignores keys it does not know. The keys listed in
  the schemas keep their meaning.
- `"$schema"` is optional. `vibloom init` writes it first, pointing at the
  schema on the repository's main branch, so editors offer completion.

## The map

```json
{
  "$schema": "https://raw.githubusercontent.com/viraloyster/VIBloom/main/schema/roots.v1.schema.json",
  "version": 1,
  "runner": ["forge", "test", "--json"],
  "tests": "test/",
  "protect": ["foundry.toml", "halmos.toml"],
  "checks": [
    {
      "tool": "halmos",
      "report": "halmos-report.json",
      "command": ["halmos", "--loop", "2", "--json-output", "halmos-report.json"]
    }
  ],
  "nodes": [
    {
      "id": "inv.assets-match-flows",
      "kind": "invariant",
      "title": "The vault's assets equal what went in minus what went out",
      "test": {
        "file": "test/Vault.t.sol",
        "contract": "VaultTest",
        "name": "invariant_assetsMatchFlows"
      },
      "watch": ["src/Vault.sol"]
    },
    {
      "id": "inv.withdraw-pays-what-it-takes",
      "kind": "invariant",
      "title": "Withdraw takes out exactly the assets it pays",
      "test": {
        "tool": "halmos",
        "file": "test/VaultSym.t.sol",
        "contract": "VaultSymTest",
        "name": "check_withdrawTakesAssetsOut"
      },
      "watch": ["src/Vault.sol"]
    }
  ]
}
```

Top level (only `version` and `nodes` are required):

| Key               | Meaning                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `version`         | Always 1.                                                                                  |
| `runner`          | The project's test command, as a list. Default `["forge", "test", "--json"]`.              |
| `report`          | Where the runner writes JUnit XML. Without it, the runner's output is `forge test --json`. |
| `timeout`         | Seconds a run, and each check's command, may take. Default 3600.                           |
| `tests`           | The tests folder. Default `test/`.                                                         |
| `protect`         | Paths only a person may change: test configuration, handlers, tool configs.                |
| `strict`          | Count nodes nobody has reviewed as needing attention. Default false.                       |
| `ignore_failures` | Globs (`*`, `?`) on `Contract.test` or a test's file: failing tests no node rests on.      |
| `checks`          | Reports of other tools, below.                                                             |
| `nodes`           | The nodes.                                                                                 |

A path is relative to the project root, with `/` between parts, no `.` or
`..` part and no leading `/`; a folder ends in `/`.

A node:

| Key          | Meaning                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `id`         | Unique; lowercase letters, digits, `.`, `_`, `-`, starting with a letter or digit.              |
| `kind`       | `invariant` (must always hold; needs a `test`), `assumption` (taken as given), `intention`.     |
| `title`      | One line.                                                                                       |
| `detail`     | Longer text.                                                                                    |
| `stance`     | `adopted`, `hypothetical` (nobody decided yet) or `off`. Default: hypothetical for assumptions. |
| `test`       | `{ "tool"?, "file", "contract"?, "name" }`: the result that decides the node.                   |
| `watch`      | Files or folders the node is about. A change puts a passed result up for review.                |
| `depends_on` | Ids this node rests on: if one fails or is off, this node is at risk.                           |
| `protected`  | Only a person may edit its test. Default true for an invariant.                                 |
| `evidence`   | Where the node comes from: `file:line`, a URL, a chain read with its block.                     |
| `accepts`    | `[{ "id", "reason" }]`: dependencies that are off on purpose, each with its reason.             |

Rules the schema cannot state: ids are unique; `depends_on` names existing
ids, never the node itself, and the links form no cycle; an `accepts` id is
one of the node's `depends_on`; a `test` with a `tool` needs a check of that
tool, and `checks` lists each tool at most once.

## Tests and checks

A node's `test` names one result. Without `tool` it comes from the project's
`runner`. With `"tool"` it comes from that entry of `checks`:

```text
{ "tool": "halmos" | "echidna" | "junit", "report": "<file>", "command": ["..."] }
```

- `halmos`: the file `halmos --json-output <file>` writes. A result is found
  by `file` and `contract` (its `test_results` key is `file:Contract`) and
  `name` (the function, parameters dropped).
- `echidna`: what `echidna --format json` prints, saved to the file
  (`sh -c "echidna ... --format json > <file>"`). A result is found by
  `contract` and `name`; `file` is the test's source in the project.
- `junit`: JUnit XML of a second runner, read like `report`.

With `command`, `vibloom check` deletes the report, runs the command (with
`timeout`; a tool that finds a counterexample may exit non-zero) and reads
the report. A command that writes no report is an error. Without `command`,
the report counts only while it is newer than every file the nodes using it
watch; otherwise those nodes are `pending review` with that reason. Checks run
with a run of the whole suite, never with a filtered one.

Medusa is not a tool here: it writes no machine-readable test results (its
reports are coverage and reverts, and its verdict is the exit code), and a
map should not depend on parsing its log.

## How states are derived

Each run is recorded with every test result and, for each node with a test, a
digest of the files it watches when the run started. From the latest result
for a node's test:

| Result                                                                                                                         | Node state     |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| passed, watched files unchanged since that run                                                                                 | holds          |
| passed, a watched file changed since                                                                                           | pending review |
| failed (Halmos COUNTEREXAMPLE, Echidna solved)                                                                                 | BROKEN         |
| passed but nothing exercised (every call or path reverted, Halmos REVERT_ALL)                                                  | VACUOUS        |
| the tool did not finish (Halmos TIMEOUT, STUCK, EXCEPTION; Echidna fuzzing, shrinking, error), or a report older than the code | pending review |
| skipped                                                                                                                        | skipped        |
| never ran                                                                                                                      | untested       |
| ran before, absent from the latest whole run                                                                                   | MISSING        |
| a protected test or guarded file differs from the last commit                                                                  | TEST CHANGED   |

A node that rests on something broken, off or unsupported is UNSUPPORTED (AT
RISK for an intention); on something pending, it is pending review. A node
without a test shows its stance. Every state but holds and off needs
attention. `check` decides from its own run only.

## The kind of guarantee

Every node with a test carries `how` in the JSON, and `status` prints it next
to the state:

| `how.kind` | From                                      | Shown                                                                           |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| `unit`     | a plain test (Foundry unit test, JUnit)   | `holds, unit`                                                                   |
| `fuzzed`   | a Foundry fuzz or invariant test, Echidna | `holds, fuzzed 64x32` (runs x calls per run, when known)                        |
| `symbolic` | Halmos                                    | `holds, symbolic (bounded, loop 2)` (loop bound when the command sets `--loop`) |

A result is never shown as a stronger kind than the tool gives: a fuzz pass is
never "proven", and a Halmos pass holds only within its bounds.
