// Deploys PoseidonT3, the Halo2 verifier and GhostPool to the EIP-8141 devnet, staking the pool in the
// ERC-8421 registry, and writes app/src/deployment.json for the app and the e2e script.
//
//   npx tsx scripts/deploy.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { formatEther, parseEther, type Address } from "viem";
import { CHAIN_ID, STAKING_REGISTRY } from "../app/src/lib/constants";
import { WITHDRAW_GAS } from "../app/src/lib/frames";
import { account, deploy, ensureFunds, publicClient, repoRoot } from "./lib/devnet";

const DENOMINATION = parseEther("0.1");
/** Strictly above the registry's 0.01 ETH minimum: the BALANCE carve-out compares with `>`. */
const STAKE = parseEther("0.012");
const UNSTAKE_DELAY_SEC = 86_400;
// The pool insists on at least this much gas for the payout frame; the app sends WITHDRAW_GAS. Below
// these floors a withdrawal could pass validation and then run out of gas in the payout, making the
// pool pay for a failed payout over and over. State: the nullifier's new slot (110k) plus a new
// recipient account (196k) or, if the payout fails, a new `owed` slot (110k) (scripts/probe-gas.ts).
// Execution: ethrex only charges state gas while as much execution gas is still available, so the
// payout failed at 100k and succeeded at 400k on the devnet.
const MIN_WITHDRAW_EXECUTION_GAS = 400_000n;
const MIN_WITHDRAW_STATE_GAS = 400_000n;
if (WITHDRAW_GAS.withdrawExecution < MIN_WITHDRAW_EXECUTION_GAS || WITHDRAW_GAS.withdrawState < MIN_WITHDRAW_STATE_GAS) {
  throw new Error("the app's withdrawal gas limits are below what the pool will accept");
}

const DEPLOYMENT_FILE = path.join(repoRoot, "app/src/deployment.json");
const acct = account();
console.log(`deployer ${acct.address}: ${formatEther(await ensureFunds(acct.address, parseEther("0.3")))} ETH`);

// A devnet reset wipes the predeployed registry until EF redeploys it; then the pool stakes later
// (scripts/stake.ts) instead of in its constructor.
const registryReady = ((await publicClient.getCode({ address: STAKING_REGISTRY })) ?? "0x") !== "0x";
if (!registryReady) console.log(`no staking registry at ${STAKING_REGISTRY} yet: deploying unstaked`);

// Code is charged as state on this devnet (scripts/probe-create.ts): PoseidonT3 (16 KB) takes about 26M
// gas, the verifier (13 KB) about 21M, GhostPool about 13M. REUSE_LIBS=1 keeps the PoseidonT3 and
// verifier of the current deployment.json when they are still on chain (only the pool is new).
const previous = existsSync(DEPLOYMENT_FILE) ? JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) : {};
const onChain = async (address?: Address) =>
  !!address && ((await publicClient.getCode({ address })) ?? "0x") !== "0x";
const reuse = process.env.REUSE_LIBS === "1" && (await onChain(previous.poseidon)) && (await onChain(previous.verifier));
const poseidon = reuse ? { address: previous.poseidon as Address } : await deploy(acct, "PoseidonT3", { gas: 40_000_000n });
const verifier = reuse ? { address: previous.verifier as Address } : await deploy(acct, "Halo2Verifier", { gas: 35_000_000n });
if (reuse) console.log(`reusing PoseidonT3 ${poseidon.address} and verifier ${verifier.address}`);
const pool = await deploy(acct, "GhostPool", {
  args: [verifier.address, DENOMINATION, MIN_WITHDRAW_EXECUTION_GAS, MIN_WITHDRAW_STATE_GAS, STAKING_REGISTRY, UNSTAKE_DELAY_SEC],
  value: registryReady ? STAKE : 0n,
  libraries: { "poseidon-solidity/PoseidonT3.sol:PoseidonT3": poseidon.address },
  gas: 25_000_000n,
});

const deployment = {
  chainId: CHAIN_ID,
  pool: pool.address,
  verifier: verifier.address,
  poseidon: poseidon.address,
  denomination: DENOMINATION.toString(),
  deployedAtBlock: Number(pool.block),
};
writeFileSync(DEPLOYMENT_FILE, JSON.stringify(deployment, null, 2) + "\n");
console.log("wrote app/src/deployment.json");
if (!registryReady) console.log("the pool is unstaked: run `npx tsx scripts/stake.ts` once the registry is back");
