// Deploys the full DrawPool stack to OPN Chain testnet using the compiled
// artifacts in ./out (produced by `node compile.js`). No on-chain compile needed.
//
// Usage:
//   1. node compile.js
//   2. cp .env.example .env  &&  fill PRIVATE_KEY
//   3. node deploy.js
//
// Writes deployment.json with all addresses for the frontend.
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const RPC = process.env.OPN_TESTNET_RPC || "https://testnet-rpc.iopn.tech";
const CHAIN_ID = 984;
const GAS_PRICE = 7_000_000_000n; // fixed 7 Gwei on OPN
const DRAW_INTERVAL = Number(process.env.DRAW_INTERVAL || 86400); // default daily
const YIELD_PER_SECOND = process.env.YIELD_PER_SECOND || "100000"; // 0.1 tUSDC/s demo drip

const OUT = path.join(__dirname, "out");
const art = (n) => JSON.parse(fs.readFileSync(path.join(OUT, `${n}.json`), "utf8"));

async function deploy(name, signer, ...args) {
  const a = art(name);
  const f = new ethers.ContractFactory(a.abi, a.bytecode, signer);
  const c = await f.deploy(...args, { gasPrice: GAS_PRICE });
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`  ${name.padEnd(22)} ${addr}`);
  return c;
}

async function main() {
  if (!process.env.PRIVATE_KEY) throw new Error("set PRIVATE_KEY in .env");
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  console.log(`Deployer: ${wallet.address}`);
  console.log(`Network:  OPN testnet (chainId ${CHAIN_ID})  RPC ${RPC}\n`);

  console.log("Deploying contracts...");
  const usdc = await deploy("MockUSDC", wallet);
  const yieldSrc = await deploy("SponsoredYieldSource", wallet, await usdc.getAddress(), wallet.address);
  const rng = await deploy("FinalityRandomness", wallet);
  const pool = await deploy(
    "DrawPool", wallet,
    await usdc.getAddress(), await yieldSrc.getAddress(), await rng.getAddress(), DRAW_INTERVAL
  );

  console.log("\nWiring...");
  await (await yieldSrc.setPool(await pool.getAddress(), { gasPrice: GAS_PRICE })).wait();
  await (await yieldSrc.setYieldPerSecond(YIELD_PER_SECOND, { gasPrice: GAS_PRICE })).wait();
  console.log("  pool wired, drip rate set");

  // Seed a sponsor reserve so the demo runs continuously.
  console.log("\nSeeding sponsor reserve (10,000 tUSDC)...");
  const seed = ethers.parseUnits("10000", 6);
  await (await usdc.mint(wallet.address, seed, { gasPrice: GAS_PRICE })).wait();
  await (await usdc.approve(await yieldSrc.getAddress(), seed, { gasPrice: GAS_PRICE })).wait();
  await (await yieldSrc.sponsor(seed, { gasPrice: GAS_PRICE })).wait();
  console.log("  reserve funded");

  const out = {
    network: "opn-testnet",
    chainId: CHAIN_ID,
    rpc: RPC,
    explorer: "https://testnet.iopn.tech",
    drawInterval: DRAW_INTERVAL,
    deployedAt: new Date().toISOString(),
    contracts: {
      MockUSDC: await usdc.getAddress(),
      SponsoredYieldSource: await yieldSrc.getAddress(),
      FinalityRandomness: await rng.getAddress(),
      DrawPool: await pool.getAddress(),
    },
  };
  fs.writeFileSync(path.join(__dirname, "deployment.json"), JSON.stringify(out, null, 2));
  const frontendAbi = {
    MockUSDC: art("MockUSDC").abi,
    SponsoredYieldSource: art("SponsoredYieldSource").abi,
    FinalityRandomness: art("FinalityRandomness").abi,
    DrawPool: art("DrawPool").abi,
  };
  // also emit frontend wiring
  fs.writeFileSync(
    path.join(__dirname, "..", "frontend", "config.js"),
    `window.DRAWPOOL_CONFIG = ${JSON.stringify(out, null, 2)};\n`
  );
  fs.writeFileSync(
    path.join(__dirname, "..", "frontend", "abi.js"),
    `window.DRAWPOOL_ABI = ${JSON.stringify(frontendAbi, null, 2)};\n`
  );
  console.log("\nDone. Wrote deployment.json, frontend/config.js, and frontend/abi.js");
  console.log("Verify the deploy tx on https://testnet.iopn.tech for your Verified Builder badge.");
}

main().catch((e) => { console.error(e); process.exit(1); });
