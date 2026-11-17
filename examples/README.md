# Examples

Three small projects set up with `vibloom`, each with its map. The run log is
local, so a fresh clone starts untested; CI runs `vibloom check` in each with
the real test runners.

- [foundry-vault](foundry-vault/): a share vault in Solidity with two
  invariants fuzzed through a handler. `vibloom init` found the invariants,
  guarded the handler and `foundry.toml`, and from forge's syntax trees set
  each invariant to watch what its test imports: `src/Vault.sol` and the
  handler.
- [pytest-ledger](pytest-ledger/): a Python ledger checked through a JUnit
  report, the route for any runner that is not Foundry.
- [hardhat-counter](hardhat-counter/): a Solidity counter tested with
  Hardhat 2 and mocha, read through `mocha-junit-reporter`. Run `npm ci`
  first; each node names its test by its full title (`Counter starts at
zero`).

Try it in `foundry-vault`: comment out `totalAssets -= assets;` in
`src/Vault.sol` and run `vibloom check`. The invariant on the vault's books
breaks, the plain unit test fails too (a failing test fails the check whether
or not a node rests on it), and the intention above the invariant is at risk:

```
$ vibloom check
Run 1: 3 test results recorded, 2 failed.
1 failing test no node rests on, which still fails the check: VaultTest.test_depositThenWithdrawReturnsEverything.
Fix it, or tie it to a node; a test known to be red can be listed in "ignore_failures" in the map.
Changed:
  inv.assets-match-flows: untested -> BROKEN
  inv.shares-are-backed: untested -> holds
  int.no-overdraw: pending review -> AT RISK
5 nodes, 2 need attention, 2 not yet reviewed.
BROKEN (rests on 1 unreviewed)   inv.assets-match-flows          The vault's assets equal everything deposited minus everything withdrawn
AT RISK (rests on 2 unreviewed)  int.no-overdraw                 Nobody can take out more than their shares are worth
holds (rests on 1 unreviewed)    inv.shares-are-backed           Shares never exist without assets behind them
hypothetical                     asm.handler-is-the-only-actor   Only the handler's deposits and withdrawals move assets in the test
hypothetical                     asm.rounding-favours-the-vault  Rounding in withdraw always favours the vault

Not yet reviewed (yours to decide: adopt it or switch it off):
- asm.handler-is-the-only-actor: vibloom edit asm.handler-is-the-only-actor --stance adopted   (or --stance off)
- asm.rounding-favours-the-vault: vibloom edit asm.rounding-favours-the-vault --stance adopted   (or --stance off)
Check failed: 2 nodes need attention, 1 failing test no node rests on.
```

To start from nothing instead, follow [docs/quickstart.md](../docs/quickstart.md)
in a copy of `foundry-vault` with its `.vibloom/` removed.
