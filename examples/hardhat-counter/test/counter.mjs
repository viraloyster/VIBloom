/* global describe, it */
import assert from "node:assert/strict";
import hre from "hardhat";

describe("Counter", function () {
  it("starts at zero", async function () {
    const counter = await hre.ethers.deployContract("Counter");
    assert.equal(await counter.count(), 0n);
  });

  it("goes up by one", async function () {
    const counter = await hre.ethers.deployContract("Counter");
    await counter.increment();
    assert.equal(await counter.count(), 1n);
  });
});
