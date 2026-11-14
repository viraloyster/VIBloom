// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "../src/Vault.sol";
import {VaultHandler} from "./handlers/VaultHandler.sol";

contract VaultTest {
    Vault internal vault;
    VaultHandler internal handler;

    function setUp() public {
        vault = new Vault();
        handler = new VaultHandler(vault);
    }

    // Foundry fuzzes only the handler.
    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_assetsMatchFlows() public view {
        assert(vault.totalAssets() == handler.deposited() - handler.withdrawn());
    }

    function invariant_sharesAreBacked() public view {
        assert(vault.totalShares() == 0 || vault.totalAssets() > 0);
    }

    function test_depositThenWithdrawReturnsEverything() public {
        uint256 shares = vault.deposit(1 ether);
        assert(vault.withdraw(shares) == 1 ether);
        assert(vault.totalAssets() == 0);
    }
}
