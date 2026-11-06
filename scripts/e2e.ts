// End to end on the devnet: deposit, prove (native ghost-cli), dry-run, show the canonical mempool
// refusing the withdrawal, send it through the alternative mempool, and check that a brand-new
// address with no ETH received the payout.
//
//   npx tsx scripts/e2e.ts            # needs app/src/deployment.json (scripts/deploy.ts)
//   E2E_PRIVILEGED=1 npx tsx scripts/e2e.ts
//     if the alternative mempool refuses it, include it through ethrex's privileged submission (the
//     devnet's demo shortcut, no mempool admission) to show the withdrawal executing on chain
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatEther, parseAbiItem, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ghostPoolAbi } from "../app/src/lib/abi.generated";
import { EXPLORER_URL, MEMPOOL_URL } from "../app/src/lib/constants";
import {
  altMempoolStatus,
  receipt,
  requiredFee,
  sendToAltMempool,
  sendToCanonicalMempool,
  simulate,
  submitPrivileged,
  withdrawalTx,
} from "../app/src/lib/frames";
import { commitmentOf, createNote, nullifierHashOf, toBytes32 } from "../app/src/lib/note";
import { buildWitness } from "../app/src/lib/witness";
import { account, ensureFunds, LEGACY_GAS_PRICE, publicClient, repoRoot, walletClient } from "./lib/devnet";

const deployment = JSON.parse(readFileSync(path.join(repoRoot, "app/src/deployment.json"), "utf8"));
const pool: Address = deployment.pool;
const denomination = BigInt(deployment.denomination);
const step = (s: string) => console.log(`\n== ${s}`);

step("deposit");
const acct = account();
await ensureFunds(acct.address, denomination + parseEther("0.05"));
const note = createNote();
const depositHash = await walletClient(acct).writeContract({
  address: pool,
  abi: ghostPoolAbi,
  functionName: "deposit",
  args: [toBytes32(commitmentOf(note))],
  value: denomination,
  type: "legacy",
  gasPrice: LEGACY_GAS_PRICE,
  gas: 5_000_000n,
});
const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositHash, timeout: 180_000 });
console.log(`alt mempool node: ${MEMPOOL_URL}`);
console.log(`deposit ${depositHash}: ${depositReceipt.status}, ${depositReceipt.gasUsed} gas`);

step("rebuild the tree from Deposit events");
const logs = await publicClient.getLogs({
  address: pool,
  event: parseAbiItem("event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)"),
  fromBlock: BigInt(deployment.deployedAtBlock),
});
const leaves = logs
  .sort((a, b) => Number(a.args.leafIndex) - Number(b.args.leafIndex))
  .map((l) => BigInt(l.args.commitment as Hex));
const recipient = privateKeyToAccount(generatePrivateKey()).address;
const maxFeePerGas = 200_000_000n; // 0.2 gwei; the base fee is 7 wei
const nonce = BigInt(await publicClient.getTransactionCount({ address: pool }));
const nullifierHash = toBytes32(nullifierHashOf(note));
const placeholderRoot = toBytes32(0n);
const fee = await requiredFee({ pool, nonce, maxFeePerGas, root: placeholderRoot, nullifierHash, recipient }, denomination);
const { witness, root } = buildWitness(note, leaves, recipient, fee);
const onchainRoot = await publicClient.readContract({ address: pool, abi: ghostPoolAbi, functionName: "currentRoot" });
console.log(`${leaves.length} deposits, root ${toBytes32(root)} (on chain ${onchainRoot}), fee ${formatEther(fee)} ETH`);
if (toBytes32(root) !== onchainRoot) throw new Error("the rebuilt tree does not match the pool's root");

step("prove (Halo2, native)");
const dir = mkdtempSync(path.join(tmpdir(), "h2pf-"));
writeFileSync(path.join(dir, "witness.json"), JSON.stringify(witness));
const started = Date.now();
const proved = JSON.parse(
  execFileSync(path.join(repoRoot, "circuits/target/release/ghost-cli"), [
    "prove",
    path.join(repoRoot, "circuits/build/kzg_bn254_15.srs"),
    path.join(repoRoot, "circuits/build/config.json"),
    path.join(dir, "witness.json"),
  ]).toString(),
);
console.log(`proof: ${(proved.proof.length - 2) / 2} bytes in ${(Date.now() - started) / 1000} s`);

const tx = withdrawalTx({ pool, nonce, maxFeePerGas, proof: proved.proof, root: toBytes32(root), nullifierHash, recipient, fee });

step("dry run (ethrex_simulateFrameTransaction)");
const sim = await simulate(tx);
console.log(JSON.stringify(sim, null, 2));

step("canonical mempool (expected to refuse: validation is capped at 100k gas)");
try {
  const hash = await sendToCanonicalMempool(tx);
  console.log(`unexpectedly accepted: ${hash}`);
} catch (e) {
  console.log(`refused: ${(e as Error).message}`);
}

step("alternative mempool");
let hash: Hex;
try {
  hash = await sendToAltMempool(tx);
  console.log(`accepted: ${hash}`);
} catch (e) {
  const message = (e as Error).message;
  console.log(`refused: ${message}`);
  if (!process.env.E2E_PRIVILEGED) {
    if (/MAX_VERIFY_GAS/.test(message)) console.log("a MAX_VERIFY_GAS refusal means the pool is not staked yet: npx tsx scripts/stake.ts");
    console.log("rerun with E2E_PRIVILEGED=1 to include the withdrawal through ethrex's privileged submission");
    process.exit(1);
  }
  step("privileged submission (devnet demo shortcut: into the next block, no mempool admission)");
  // ethrex keeps a privileged submission only for its very next payload build, so resubmit each
  // block, as the sidecar's own relayer does, until it lands.
  hash = await submitPrivileged(tx);
  console.log(`submitted: ${hash}`);
  for (let attempt = 1; attempt <= 15 && !(await receipt(hash).catch(() => null)); attempt++) {
    await new Promise((r) => setTimeout(r, 6_000));
    await submitPrivileged(tx).catch((e) => console.log(`  resubmit ${attempt}: ${(e as Error).message}`));
  }
}
let pushed = false;
for (let i = 0; i < 40; i++) {
  const r = await receipt(hash).catch(() => null);
  if (r) {
    console.log(`mined in block ${BigInt(r.blockNumber)}: status ${r.status}, frames ${JSON.stringify(r.frameReceipts)}`);
    break;
  }
  if (process.env.E2E_PRIVILEGED && i >= 10) {
    // Admitted, but not forwarded by the sidecar after 30 s: hand ethrex the very same transaction.
    if (!pushed) step("privileged submission (the sidecar has not forwarded the admitted transaction after 30 s)");
    pushed = true;
    await submitPrivileged(tx).catch((e) => console.log(`  privileged: ${(e as Error).message}`));
  } else {
    const s = await altMempoolStatus(hash).catch((e) => ({ status: (e as Error).message }));
    console.log(`  ${s.status}`);
  }
  await new Promise((r) => setTimeout(r, 3000));
}

step("result");
const balance = await publicClient.getBalance({ address: recipient });
console.log(`recipient ${recipient} (a fresh key, never funded) now holds ${formatEther(balance)} ETH`);
console.log(`expected ${formatEther(denomination - fee)} ETH; explorer: ${EXPLORER_URL} (search ${hash})`);
if (balance !== denomination - fee) process.exitCode = 1;
