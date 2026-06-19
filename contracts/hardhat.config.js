require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PK = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

module.exports = {
  solidity: {
    version: "0.8.30",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  paths: { sources: "./src", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
  networks: {
    hardhat: { hardfork: "cancun" },
    opnTestnet: {
      url: process.env.OPN_TESTNET_RPC || "https://testnet-rpc.iopn.tech",
      chainId: 984,
      gasPrice: 7000000000,
      accounts: PK,
    },
  },
};
