const { ethers } = require("ethers");
const ganache = require("ganache");
const fs = require("fs"); const path = require("path");
const OUT = path.join(__dirname, "out".replace("out","../out"));
const art = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "out", `${n}.json`), "utf8"));

let passed=0, failed=0;
const check=(l,c)=>{ c?(passed++,console.log("  PASS",l)):(failed++,console.log("  FAIL",l)); };
const eq=(l,a,b)=>check(`${l} (${a} == ${b})`, a.toString()===b.toString());

async function main(){
  const gprovider = ganache.provider({ logging:{quiet:true}, chain:{hardfork:"shanghai"}, miner:{defaultGasPrice:"0x1"} });
  const provider = new ethers.BrowserProvider(gprovider);
  const accts = await gprovider.request({ method:"eth_accounts", params:[] });
  const signer = async (i)=> await provider.getSigner(accts[i]);
  const deployer=await signer(0), alice=await signer(1), bob=await signer(2), sponsor=await signer(3);
  const A = accts.map(a=>ethers.getAddress(a));
  const mine=async(n=1)=>{ for(let i=0;i<n;i++) await gprovider.request({method:"evm_mine",params:[]}); };
  const incTime=async(s)=>{ await gprovider.request({method:"evm_increaseTime",params:[s]}); await gprovider.request({method:"evm_mine",params:[]}); };
  const deploy=async(name,s,...args)=>{ const a=art(name); const f=new ethers.ContractFactory(a.abi,a.bytecode,s); const c=await f.deploy(...args); await c.waitForDeployment(); return c; };

  const D=6, U=(x)=>ethers.parseUnits(x.toString(),D);
  console.log("Deploying...");
  const usdc=await deploy("MockUSDC",deployer);
  const yieldSrc=await deploy("SponsoredYieldSource",deployer, await usdc.getAddress(), A[0]);
  const rng=await deploy("FinalityRandomness",deployer);
  const DRAW_INTERVAL=60;
  const pool=await deploy("DrawPool",deployer, await usdc.getAddress(), await yieldSrc.getAddress(), await rng.getAddress(), DRAW_INTERVAL);
  await (await yieldSrc.connect(deployer).setPool(await pool.getAddress())).wait();
  await (await yieldSrc.connect(deployer).setYieldPerSecond(U("0.1"))).wait();
  const poolAddr=await pool.getAddress();

  console.log("\n[0] startDraw reverts before interval / with nothing deposited");
  let tooEarly=false; try{ await pool.connect(alice).startDraw.staticCall(); }catch{ tooEarly=true; }
  check("startDraw reverts immediately after deploy", tooEarly);

  console.log("\n[1] Faucet + deposits");
  for(const s of [alice,bob,sponsor]) await (await usdc.connect(s).faucet()).wait();
  await (await usdc.connect(alice).approve(poolAddr,U("400"))).wait();
  await (await pool.connect(alice).deposit(U("400"))).wait();
  await (await usdc.connect(bob).approve(poolAddr,U("100"))).wait();
  await (await pool.connect(bob).deposit(U("100"))).wait();
  eq("total deposited", await pool.totalDeposited(), U("500"));
  eq("alice odds bps", await pool.oddsBps(A[1]), 8000n);
  eq("bob odds bps", await pool.oddsBps(A[2]), 2000n);
  eq("participant count", await pool.participantCount(), 2n);

  console.log("\n[2] Sponsor seeds reserve; yield drips");
  await (await usdc.connect(sponsor).approve(await yieldSrc.getAddress(),U("500"))).wait();
  await (await yieldSrc.connect(sponsor).sponsor(U("500"))).wait();
  await incTime(100);
  const prize=await pool.currentPrize();
  check("prize accrued ~10 tUSDC", prize>=U("10") && prize<=U("10.3"));

  console.log("\n[3] No-loss withdraw 1:1");
  const before=await usdc.balanceOf(A[2]);
  await (await pool.connect(bob).withdraw(U("50"))).wait();
  const after=await usdc.balanceOf(A[2]);
  eq("bob got exactly 50 back", after-before, U("50"));
  await (await usdc.connect(bob).approve(poolAddr,U("50"))).wait();
  await (await pool.connect(bob).deposit(U("50"))).wait();

  console.log("\n[4] Draw lifecycle");
  await incTime(DRAW_INTERVAL+1);
  await (await pool.connect(alice).startDraw()).wait();
  check("pool locked during draw", (await pool.drawActive())===true);
  let locked=false; try{ await (await pool.connect(alice).deposit(U("1"))).wait(); }catch{ locked=true; }
  check("deposit reverts while locked", locked);
  let notReady=false; try{ await (await pool.connect(alice).award.staticCall()); }catch{ notReady=true; }
  check("award not ready before reveal window", notReady);
  await mine(6);
  const totalBefore=await pool.totalDeposited();
  while(!(await rng.isReady(poolAddr, await pool.drawCount()))) await mine(1);
  await (await pool.connect(bob).award()).wait();
  check("pool unlocked after award", (await pool.drawActive())===false);
  const h=await pool.history(0);
  check("winner selected", h.winner!==ethers.ZeroAddress);
  check("prize>0", h.prize>0n);
  eq("prize auto-compounded into total", await pool.totalDeposited(), totalBefore+h.prize);
  const isPart=[A[1],A[2]].map(x=>x.toLowerCase()).includes(h.winner.toLowerCase());
  check("winner is real participant", isPart);
  const expBal=(h.winner.toLowerCase()===A[1].toLowerCase())?U("400")+h.prize:U("100")+h.prize;
  eq("winner balance includes prize", await pool.balanceOf(h.winner), expBal);

  console.log("\n[5] Second draw distribution sanity (100 draws, weighted)");
  // statistical: run many draws, alice(~80%) should win far more than bob
  let aliceWins=0, bobWins=0;
  for(let i=0;i<60;i++){
    await incTime(DRAW_INTERVAL+1);
    await (await pool.connect(alice).startDraw()).wait();
    await mine(8);
    let done=false;
    for(let r=0; r<5 && !done; r++){
      try { await (await pool.connect(alice).award()).wait(); done=true; }
      catch { await mine(2); }
    }
    if(!done){ console.log(`  award failed permanently at draw ${i}`); throw new Error("award stuck"); }
    const hl=await pool.historyLength();
    const last=await pool.history(hl-1n);
    if(last.winner.toLowerCase()===A[1].toLowerCase()) aliceWins++; else bobWins++;
  }
  console.log(`  alice wins=${aliceWins} bob wins=${bobWins} (alice ~80% expected)`);
  check("higher-balance depositor wins more often", aliceWins>bobWins);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  await gprovider.disconnect();
  process.exit(failed===0?0:1);
}
main().catch(e=>{console.error(e); process.exit(1);});
