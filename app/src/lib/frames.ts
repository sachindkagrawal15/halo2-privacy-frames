import { encodeFunctionData, type Address, type Hex } from "viem";
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { encodeTx, frame, newTx, txHash, type FrameTx } from "@forshtat/hegota-support/tx";
import { toWire } from "@forshtat/hegota-support/rpc";
import { ghostPoolAbi } from "./abi.generated";
import { CHAIN_ID, ETHREX_URL, MEMPOOL_URL } from "./constants";
import { rpc } from "./rpc";

/**
 * Gas limits of a withdrawal's two frames, measured on the devnet. The VERIFY frame uses about 321k
 * (the Halo2 verifier is 292k of it). The SENDER frame uses only about 25k of execution gas but about
 * 330k of state gas (the nullifier's new slot, and the recipient's new account), and ethrex will only
 * charge state gas while at least as much execution gas is still available: with a 100k execution
 * limit the payout ran out of gas, with 400k it succeeded.
 */
export const WITHDRAW_GAS = {
  verifyExecution: 700_000n,
  withdrawExecution: 400_000n,
  withdrawState: 450_000n,
} as const;

/** Every proof of this circuit has the same size, so a placeholder can size the transaction before proving. */
export const PROOF_BYTES = 1984;
const PLACEHOLDER_PROOF = `0x${"ff".repeat(PROOF_BYTES)}` as Hex;

export interface Withdrawal {
  pool: Address;
  nonce: bigint;
  maxFeePerGas: bigint;
  proof: Hex;
  root: Hex;
  nullifierHash: Hex;
  recipient: Address;
  fee: bigint;
}

/**
 * The withdrawal as a frame transaction whose sender is the pool:
 *   frame 0  VERIFY  pool.validateWithdrawal(proof, root)   approves execution and payment
 *   frame 1  SENDER  pool.withdraw(nullifierHash, recipient, fee)
 * There is no signature: the proof checked by frame 0 is what authorizes it.
 */
export function withdrawalTx(w: Withdrawal): FrameTx {
  return newTx({
    chainId: CHAIN_ID,
    sender: w.pool,
    nonceSeq: w.nonce,
    signatures: [],
    fees: { maxFeePerGas: w.maxFeePerGas },
    frames: [
      frame(profile, "VERIFY", {
        scope: "EXECUTION_AND_PAYMENT",
        execution: WITHDRAW_GAS.verifyExecution,
        data: encodeFunctionData({ abi: ghostPoolAbi, functionName: "validateWithdrawal", args: [w.proof, w.root] }),
      }),
      frame(profile, "SENDER", {
        target: w.pool,
        execution: WITHDRAW_GAS.withdrawExecution,
        state: WITHDRAW_GAS.withdrawState,
        data: encodeFunctionData({
          abi: ghostPoolAbi,
          functionName: "withdraw",
          args: [w.nullifierHash, w.recipient, w.fee],
        }),
      }),
    ],
  });
}

export const rawFrameTx = (tx: FrameTx): Hex => encodeTx(profile, tx);
export const frameTxHash = (tx: FrameTx): Hex => txHash(profile, tx);

/**
 * What the devnet's ethrex returns. `canonicalMempoolValid` is always false for a withdrawal: the
 * canonical mempool caps the VERIFY frame's gas limit at 100k. What matters is `executionStatus`.
 */
export interface Simulation {
  maxCost: Hex;
  canonicalMempoolValid: boolean;
  canonicalMempoolViolation: string | null;
  executionStatus: "success" | "reverted" | null;
  executionError: string | null;
  failedFrameIndex: number | null;
  haltReason: string | null;
  revertData: Hex | null;
  frames: { gasUsed: Hex; succeeded: boolean }[] | null;
  gasUsed: Hex | null;
  payer: Address | null;
  prefixShape: string | null;
}

/** ethrex's dry run: the canonical admission checks, then a full execution. Never submits. */
export const simulate = (tx: FrameTx) => rpc<Simulation>(ETHREX_URL, "ethrex_simulateFrameTransaction", [rawFrameTx(tx)]);

/**
 * The fee the proof must commit to: the pool refuses any withdrawal whose maximum cost exceeds it.
 * Sized with a placeholder proof of all-0xff bytes, so calldata costs are an upper bound.
 */
export async function requiredFee(base: Omit<Withdrawal, "proof" | "fee">, denomination: bigint): Promise<bigint> {
  const sim = await simulate(withdrawalTx({ ...base, proof: PLACEHOLDER_PROOF, fee: denomination }));
  const maxCost = BigInt(sim.maxCost);
  return maxCost + maxCost / 10n; // headroom in case the fee word itself changes the calldata cost
}

/** Into the ERC-8421 alternative mempool: the devnet's gateway, or your own node (MEMPOOL_URL). */
export const sendToAltMempool = (tx: FrameTx) => rpc<Hex>(MEMPOOL_URL, "eth_sendFrameTransaction", [toWire(tx)]);

/** Into ethrex's canonical EIP-8141 mempool, which caps validation at 100k gas. */
export const sendToCanonicalMempool = (tx: FrameTx) => rpc<Hex>(ETHREX_URL, "eth_sendRawTransaction", [rawFrameTx(tx)]);

/**
 * The devnet's demo shortcut: ethrex puts the transaction into its next block without any mempool
 * admission (the sidecar's own relayer uses it). Only for showing on-chain execution while the
 * devnet's sidecar still applies EIP-8141's 100k validation cap to staked senders too.
 */
export const submitPrivileged = (tx: FrameTx) => rpc<Hex>(ETHREX_URL, "ethrex_submitPrivilegedFrameTransaction", [rawFrameTx(tx)]);

export interface FrameTxStatus {
  status: "New" | "Pending" | "Submitted" | "OnChain" | "Finalized" | "Cancelled" | "Reverted";
  reason?: string;
  transaction?: unknown;
}

export const altMempoolStatus = (hash: Hex) => rpc<FrameTxStatus>(MEMPOOL_URL, "skandha_frameTransactionStatus", [hash]);

export interface FrameReceipt {
  status: Hex;
  blockNumber: Hex;
  gasUsed: Hex;
  frameReceipts?: { status: Hex; gasUsed?: Hex; stateGasUsed?: Hex }[];
}

export const receipt = (hash: Hex) => rpc<FrameReceipt | null>(ETHREX_URL, "eth_getTransactionReceipt", [hash]);
