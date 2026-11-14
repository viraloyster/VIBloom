# Examples

Two small projects set up with `vibloom`, each with its map and one recorded
run. CI runs `vibloom check` in both with the real test runners.

- [foundry-vault](foundry-vault/): a share vault in Solidity with two
  invariants fuzzed through a handler. `vibloom init` found the invariants and
  guarded the handler and `foundry.toml`.
- [pytest-ledger](pytest-ledger/): a Python ledger checked through a JUnit
  report, the route for any runner that is not Foundry.

Try it in `foundry-vault`: comment out `totalAssets -= assets;` in
`src/Vault.sol` and run `vibloom check`. The invariant on the vault's books
breaks, the assumption that rests on it loses its support and the intention
above them is at risk:

```
BROKEN        inv.assets-match-flows          The vault's assets equal everything deposited minus everything withdrawn
holds         inv.shares-are-backed           Shares never exist without assets behind them
UNSUPPORTED   asm.handler-is-the-only-actor   Only the handler's deposits and withdrawals move assets in the test
hypothetical  asm.rounding-favours-the-vault  Rounding in withdraw always favours the vault
AT RISK       int.no-overdraw                 Nobody can take out more than their shares are worth
```
