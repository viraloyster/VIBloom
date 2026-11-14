// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "../../src/Vault.sol";

/// What the fuzzer may do to the vault. It also keeps its own count of what
/// went in and out, to compare with the vault's books.
contract VaultHandler {
    Vault public immutable vault;
    uint256 public deposited;
    uint256 public withdrawn;

    constructor(Vault vault_) {
        vault = vault_;
    }

    function deposit(uint256 assets) external {
        assets = 1 + (assets % 1e24);
        vault.deposit(assets);
        deposited += assets;
    }

    function withdraw(uint256 shares) external {
        uint256 mine = vault.sharesOf(address(this));
        if (mine == 0) return;
        shares = 1 + (shares % mine);
        withdrawn += vault.withdraw(shares);
    }
}
