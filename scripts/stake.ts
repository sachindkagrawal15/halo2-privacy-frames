// Stakes the deployed pool in the ERC-8421 registry (for a pool deployed while the registry was
// missing, e.g. right after a devnet reset). The pool calls the registry itself, so the stake is its own.
//
//   npx tsx scripts/stake.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatEther, parseEther, type Address } from "viem";
import { ghostPoolAbi } from "../app/src/lib/abi.generated";
import { STAKING_REGISTRY } from "../app/src/lib/constants";
import { account, ensureFunds, LEGACY_GAS_PRICE, publicClient, repoRoot, walletClient } from "./lib/devnet";

/** Strictly above the registry's 0.01 ETH minimum. */
const STAKE = parseEther("0.012");
const UNSTAKE_DELAY_SEC = 86_400;

const { pool } = JSON.parse(readFileSync(path.join(repoRoot, "app/src/deployment.json"), "utf8")) as { pool: Address };
if (((await publicClient.getCode({ address: STAKING_REGISTRY })) ?? "0x") === "0x") {
  throw new Error(`there is no staking registry at ${STAKING_REGISTRY} yet`);
}
const acct = account();
await ensureFunds(acct.address, STAKE + parseEther("0.01"));
const hash = await walletClient(acct).writeContract({
  address: pool,
  abi: ghostPoolAbi,
  functionName: "stake",
  args: [STAKING_REGISTRY, UNSTAKE_DELAY_SEC],
  value: STAKE,
  type: "legacy",
  gasPrice: LEGACY_GAS_PRICE,
  gas: 1_000_000n,
});
const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
console.log(`staked ${formatEther(STAKE)} ETH for ${pool}: ${receipt.status} (${hash})`);
