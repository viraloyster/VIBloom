# Examples

Two small projects set up with `vibloom`, each with its map. The run log is
local, so a fresh clone starts untested; CI runs `vibloom check` in both with
the real test runners.

- [foundry-vault](foundry-vault/): a share vault in Solidity with two
  invariants fuzzed through a handler. `vibloom init` found the invariants,
  guarded the handler and `foundry.toml`, and from forge's syntax trees set
  each invariant to watch what its test imports: `src/Vault.sol` and the
  handler.
- [pytest-ledger](pytest-ledger/): a Python ledger checked through a JUnit
  report, the route for any runner that is not Foundry.

Try it in `foundry-vault`: comment out `totalAssets -= assets;` in
`src/Vault.sol` and run `vibloom check`. The invariant on the vault's books
breaks, the assumption that rests on it loses its support and the intention
above them is at risk:

```
5 nodes, 3 need attention, 2 not yet reviewed.
BROKEN                    inv.assets-match-flows          The vault's assets equal everything deposited minus everything withdrawn
UNSUPPORTED (unreviewed)  asm.handler-is-the-only-actor   Only the handler's deposits and withdrawals move assets in the test
AT RISK                   int.no-overdraw                 Nobody can take out more than their shares are worth
holds                     inv.shares-are-backed           Shares never exist without assets behind them
hypothetical              asm.rounding-favours-the-vault  Rounding in withdraw always favours the vault

Not yet reviewed (as the verifier, adopt it or switch it off):
- asm.handler-is-the-only-actor: vibloom edit asm.handler-is-the-only-actor --stance adopted   (or --stance off)
- asm.rounding-favours-the-vault: vibloom edit asm.rounding-favours-the-vault --stance adopted   (or --stance off)
```
