// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A minimal share vault over an internal balance, small enough to read in
/// one sitting. Assets enter with deposit and leave with withdraw; shares
/// track each account's claim.
contract Vault {
    uint256 public totalAssets;
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    function deposit(uint256 assets) external returns (uint256 shares) {
        require(assets > 0, "zero assets");
        shares = totalShares == 0 ? assets : (assets * totalShares) / totalAssets;
        require(shares > 0, "zero shares");
        totalAssets += assets;
        totalShares += shares;
        sharesOf[msg.sender] += shares;
    }

    function withdraw(uint256 shares) external returns (uint256 assets) {
        require(shares > 0 && shares <= sharesOf[msg.sender], "bad shares");
        assets = (shares * totalAssets) / totalShares;
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        totalAssets -= assets;
    }
}
