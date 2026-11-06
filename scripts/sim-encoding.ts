// Dry-runs a withdrawal-shaped frame transaction (no signatures) against an existing frame-tx wallet on
// the devnet: checks that ethrex decodes our encoding and reports how it computes maxCost.
import { simulate, withdrawalTx, PROOF_BYTES, WITHDRAW_GAS } from "../app/src/lib/frames";
const sender = "0x669434a22476Fd704ced8366EE830F079394a875"; // someone's workshop wallet (has code)
const maxFeePerGas = 200_000_000n;
const tx = withdrawalTx({
  pool: sender, nonce: 8n, maxFeePerGas,
  proof: `0x${"ff".repeat(PROOF_BYTES)}`, root: `0x${"11".repeat(32)}`, nullifierHash: `0x${"22".repeat(32)}`,
  recipient: "0x8943545177806ED17B9F23F0a21ee5948eCaa776", fee: 10n ** 15n,
});
const sim = await simulate(tx);
console.log(JSON.stringify(sim, null, 1));
const limits = WITHDRAW_GAS.verifyExecution + WITHDRAW_GAS.withdrawExecution + WITHDRAW_GAS.withdrawState;
console.log("sum of frame limits x maxFee =", (limits * maxFeePerGas).toString(), " maxCost =", BigInt(sim.maxCost).toString(),
  " => implied gas =", (BigInt(sim.maxCost) / maxFeePerGas).toString(), "vs limits", limits.toString());
