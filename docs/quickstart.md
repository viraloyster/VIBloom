# Quickstart

From nothing to a map that holds your project to its tests, on a Foundry
project. Each step prints the next one; `vibloom` alone always says where
things stand. The outputs are from [examples/foundry-vault](../examples/foundry-vault/).

**1. Install.** Download `vibloom` from the
[releases](https://github.com/viraloyster/VIBloom/releases), or
`cargo install --locked --git https://github.com/viraloyster/VIBloom vibloom`.

**2. Start.** At the project's root, `vibloom init` finds the invariant tests
(`invariant_*`), guards them and what they import, writes
`.vibloom/roots.json` and installs the commit check. Then run the tests:

```
$ vibloom check
Run 1: 3 test results recorded.
Changed:
  inv.assets-match-flows: untested -> holds
  inv.shares-are-backed: untested -> holds
2 nodes, 0 need attention, 0 not yet reviewed.
holds  inv.assets-match-flows  invariant_assetsMatchFlows
holds  inv.shares-are-backed   invariant_sharesAreBacked
```

`check` exits 1 when a node needs attention or any test failed.

**3. Write down the rest.** A node is an invariant (tied to a test), an
assumption (what the code takes as given) or an intention (what it is for).
`--on X` always means: this node rests on X; if X fails, this is at risk.

```bash
vibloom add intention "Nobody can take out more than their shares are worth" --on inv.assets-match-flows --on inv.shares-are-backed
vibloom add "The handler covers every way assets enter or leave the vault"
vibloom edit inv.assets-match-flows --on asm.the-handler-covers-every-way
```

`add` with no kind adds an assumption. It starts hypothetical, not yet
reviewed, until you adopt it (`vibloom edit <id> --stance adopted`) or switch it
off. Each command prints the id it created or changed.

**4. When it breaks.** Comment out `totalAssets -= assets;` in
`src/Vault.sol` and `vibloom check` reports the invariant BROKEN and the
intention resting on it AT RISK, exit 1. `vibloom` then says what to do:

```
$ vibloom
4 nodes in .vibloom/roots.json; 2 test runs recorded here.
Proven: 1 invariant holds in the latest run.
  - invariant_sharesAreBacked
Needs attention: 2.
  - inv.assets-match-flows BROKEN: failure: panic: assertion failed (0x01)
  - int.nobody-can-take-out-more-than AT RISK: because of inv.assets-match-flows
Next: `vibloom status` shows every node and why.
```

**5. Who decides.** You, at your terminal, change the map. An AI agent is the
builder: `vibloom` recognises it by the variables Claude Code, Codex, Cursor
and Gemini CLI set, and refuses it `add`, `edit`, `remove`, `scan` and
deciding proposals; it can propose. `vibloom setup claude` (or `codex`)
connects the agent and writes its role down. This is a speed bump for honest
agents, not a lock: the enforcement is `vibloom check --base` in CI
([Where the rules are enforced](guard.md#where-the-rules-are-enforced)).

**6. No invariant tests yet?** `init` says so. `vibloom survey` reads who may
call what and lists the invariants worth a test; `vibloom survey --propose`
files the assumptions it found as proposals. `vibloom proposals` lists them by
contract; `vibloom proposals accept --all --contract Vat` takes one contract's
at once, `reject` turns them down.

## An invariant test

Name it `invariant_...` in a file under the tests folder, then run
`vibloom scan` to add it to the map. Foundry calls the contract's functions
at random and checks the invariant after each sequence:

```solidity
import {Vault} from "../src/Vault.sol";

contract VaultInvariants {
    Vault vault;

    function setUp() public {
        vault = new Vault();
    }

    function invariant_sharesAreBacked() public view {
        assert(vault.totalShares() == 0 || vault.totalAssets() > 0);
    }
}
```

Everything else, from CI to the hooks, is in the [reference](guard.md).
