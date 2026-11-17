import "@nomicfoundation/hardhat-ethers";

// vibloom reads the JUnit report this reporter writes.
export default {
  solidity: "0.8.24",
  mocha: {
    reporter: "mocha-junit-reporter",
    reporterOptions: { mochaFile: "cache/vibloom-junit.xml" },
  },
};
