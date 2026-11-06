import { formatEther, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { proveWithdrawal, prepareProver } from "../prover/client";
import { ghostPoolAbi } from "./abi.generated";
import { setIsolationKey } from "./anon";
import { fetchCommitments, LEGACY_GAS_PRICE, publicClient, walletClient } from "./chain";
import { CHAIN_ID } from "./constants";
import { denomination, deployment } from "./deployment";
import {
  altMempoolStatus,
  receipt,
  requiredFee,
  sendToAltMempool,
  sendToCanonicalMempool,
  simulate,
  submitPrivileged,
  withdrawalTx,
  type Simulation,
} from "./frames";
import { commitmentOf, createNote, decodeNote, encodeNote, nullifierHashOf, toBytes32 } from "./note";
import { RpcError } from "./rpc";
import { buildWitness } from "./witness";

/** 0.2 gwei; the devnet base fee is 7 wei. The proof commits to a fee sized for this price. */
export const MAX_FEE_PER_GAS = 200_000_000n;

function requirePool(): Address {
  if (!deployment.pool) throw new Error("The pool is not deployed on this devnet yet.");
  return deployment.pool;
}

/**
 * Creates a note and deposits it. `onNote` fires before anything is sent, so the depositor can save
 * the note even if the page closes while the transaction is pending.
 */
export async function deposit(account: PrivateKeyAccount, onNote: (noteText: string) => void) {
  const pool = requirePool();
  const note = createNote();
  onNote(encodeNote(note, CHAIN_ID, pool));
  setIsolationKey(`deposit:${account.address}`);
  try {
    const hash = await walletClient(account).writeContract({
      address: pool,
      abi: ghostPoolAbi,
      functionName: "deposit",
      args: [toBytes32(commitmentOf(note))],
      value: denomination,
      type: "legacy",
      gasPrice: LEGACY_GAS_PRICE,
      gas: 5_000_000n,
    });
    const mined = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (mined.status !== "success") throw new Error(`The deposit transaction reverted (${hash}).`);
    return { hash, blockNumber: mined.blockNumber };
  } finally {
    setIsolationKey(undefined);
  }
}

export type StepId = "scan" | "prover" | "fee" | "prove" | "simulate" | "canonical" | "alt" | "privileged" | "mined";

/** `optional` steps only show up when they happen. */
export const STEPS: { id: StepId; label: string; optional?: boolean }[] = [
  { id: "scan", label: "Rebuild the deposit tree from chain events" },
  { id: "prover", label: "Load the Halo2 prover and rebuild its proving key" },
  { id: "fee", label: "Size the fee to the transaction's maximum gas cost" },
  { id: "prove", label: "Prove the deposit and bind recipient + fee, in this tab" },
  { id: "simulate", label: "Dry-run the frame transaction on ethrex" },
  { id: "canonical", label: "Offer it to the canonical EIP-8141 mempool" },
  { id: "alt", label: "Send it to the ERC-8421 alternative mempool" },
  { id: "privileged", label: "Devnet shortcut: include it through ethrex's privileged submission", optional: true },
  { id: "mined", label: "Wait for inclusion" },
];

export interface StepEvent {
  id: StepId;
  /** `warned`: the step did not go through, and the flow carries on another way. */
  status: "active" | "done" | "failed" | "warned";
  detail?: string;
}

export interface WithdrawResult {
  hash: Hex;
  recipient: Address;
  amount: bigint;
  fee: bigint;
  blockNumber: bigint;
  validationGas?: bigint;
  canonicalVerdict: string;
  /**
   * How the withdrawal reached a block: through the alternative mempool alone; admitted there and also
   * pushed through ethrex's privileged submission because the sidecar did not forward it in time; or,
   * when the alternative mempool refused it (`altVerdict` says why), through the privileged submission.
   */
  route: "alt-mempool" | "alt-mempool+privileged" | "privileged";
  altVerdict?: string;
  proofMs: number;
  delivered: boolean;
}

/** How long an admitted withdrawal may wait for the sidecar to forward it before the app pushes it too. */
const RELAY_PATIENCE_MS = 30_000;

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

export async function withdraw(
  noteText: string,
  recipient: Address,
  emit: (e: StepEvent) => void,
): Promise<WithdrawResult> {
  const { note, chainId, pool } = decodeNote(noteText);
  if (chainId !== CHAIN_ID) throw new Error(`This note is for chain ${chainId}, not the devnet (${CHAIN_ID}).`);
  let current: StepId = "scan";
  const step = (id: StepId, detail?: string) => {
    current = id;
    emit({ id, status: "active", detail });
  };
  const done = (detail?: string) => emit({ id: current, status: "done", detail });
  const nullifierHash = toBytes32(nullifierHashOf(note));
  // Every request of this withdrawal travels under one isolation key of its own (see anon.ts).
  setIsolationKey(`withdraw:${nullifierHash}`);

  try {
    step("scan");
    const proverReady = prepareProver(); // in parallel with the chain reads
    const [commitments, spent] = await Promise.all([
      fetchCommitments(pool, BigInt(deployment.deployedAtBlock)),
      publicClient.readContract({ address: pool, abi: ghostPoolAbi, functionName: "nullifierSpent", args: [nullifierHash] }),
    ]);
    if (spent) throw new Error("This note has already been withdrawn.");
    const leafIndex = commitments.indexOf(commitmentOf(note));
    if (leafIndex < 0) throw new Error("This note's deposit is not in the pool (yet?).");
    done(`${commitments.length} deposits; yours is leaf #${leafIndex}`);

    step("prover");
    const vkHash = await proverReady;
    done(`verifying key ${short(vkHash)} matches the on-chain verifier`);

    step("fee");
    const nonce = BigInt(await publicClient.getTransactionCount({ address: pool }));
    const fee = await requiredFee(
      { pool, nonce, maxFeePerGas: MAX_FEE_PER_GAS, root: toBytes32(0n), nullifierHash, recipient },
      denomination,
    );
    if (fee >= denomination) throw new Error("Gas is too expensive right now to withdraw this note.");
    done(`${formatEther(fee)} ETH, paid from the note itself`);

    step("prove");
    const { witness, root } = buildWitness(note, commitments, recipient, fee);
    const proof = await proveWithdrawal(witness);
    done(`${(proof.proof.length - 2) / 2}-byte Halo2 proof in ${(proof.ms / 1000).toFixed(1)} s`);

    // The proof does not commit to the nonce, so a withdrawal that lost a nonce race is just rebuilt.
    const build = async () =>
      withdrawalTx({
        pool,
        nonce: BigInt(await publicClient.getTransactionCount({ address: pool })),
        maxFeePerGas: MAX_FEE_PER_GAS,
        proof: proof.proof,
        root: toBytes32(root),
        nullifierHash,
        recipient,
        fee,
      });
    let tx = await build();

    step("simulate");
    const sim: Simulation = await simulate(tx);
    if (sim.executionStatus !== "success") {
      const where = sim.failedFrameIndex === null ? "" : ` in frame ${sim.failedFrameIndex}`;
      throw new Error(`The dry run failed${where}: ${sim.executionError ?? sim.haltReason ?? "unknown reason"} ${sim.revertData ?? ""}`.trim());
    }
    const validationGas = sim.frames?.[0] ? BigInt(sim.frames[0].gasUsed) : undefined;
    done(`both frames succeed; the VERIFY frame used ${validationGas?.toLocaleString() ?? "?"} gas`);

    step("canonical");
    let canonicalVerdict: string;
    let hash: Hex | undefined;
    try {
      hash = await sendToCanonicalMempool(tx);
      canonicalVerdict = "accepted (unexpected)";
    } catch (e) {
      canonicalVerdict = e instanceof RpcError ? e.message : String(e);
    }
    done(hash ? canonicalVerdict : `refused, as expected: ${canonicalVerdict}`);

    step("alt");
    let route: WithdrawResult["route"] = "alt-mempool";
    let altVerdict: string | undefined;
    if (hash) {
      done("skipped: the canonical mempool took it");
    } else {
      try {
        hash = await sendToAltMempool(tx);
      } catch (e) {
        altVerdict = (e as Error).message;
        if (/nonce/i.test(altVerdict)) {
          tx = await build();
          hash = await sendToAltMempool(tx).catch((again: Error) => {
            altVerdict = again.message;
            return undefined;
          });
        }
      }
      if (hash) {
        altVerdict = undefined;
        done(`admitted: ${short(hash)}`);
      } else {
        // The devnet's sidecar refuses what ERC-8421 is meant to admit (see README, Status). Its
        // operator-only shortcut still shows the very same transaction executing on chain.
        emit({ id: "alt", status: "warned", detail: `refused: ${altVerdict}` });
        step("privileged");
        route = "privileged";
        hash = await submitPrivileged(tx);
        done(`submitted ${short(hash)}: ethrex puts it in its next block, without mempool admission`);
      }
    }

    step("mined");
    const started = Date.now();
    while (Date.now() - started < 180_000) {
      const mined = await receipt(hash).catch(() => null);
      if (mined) {
        const delivered = (mined.frameReceipts ?? []).every((f) => f.status === "0x1") && mined.status === "0x1";
        done(`block ${BigInt(mined.blockNumber)}, ${delivered ? "all frames succeeded" : "a frame failed"}`);
        return {
          hash,
          recipient,
          amount: denomination - fee,
          fee,
          blockNumber: BigInt(mined.blockNumber),
          validationGas,
          canonicalVerdict,
          route,
          altVerdict,
          proofMs: proof.ms,
          delivered,
        };
      }
      if (route === "alt-mempool" && Date.now() - started > RELAY_PATIENCE_MS) {
        // Admitted, but the sidecar has not forwarded it to the block builder. Hand ethrex the very
        // same transaction: one hash and one nonce, so it can land only once, by whichever route.
        route = "alt-mempool+privileged";
        emit({
          id: "privileged",
          status: "done",
          detail: `the sidecar had not forwarded it after ${RELAY_PATIENCE_MS / 1000} s, so the same transaction also went to ethrex's privileged submission`,
        });
      }
      if (route !== "alt-mempool") {
        // ethrex keeps a privileged submission for its next payload build only: resubmit each block.
        emit({ id: "mined", status: "active", detail: "waiting for a block" });
        await submitPrivileged(tx).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 6_000));
        continue;
      }
      const status = await altMempoolStatus(hash).catch(() => undefined);
      emit({ id: "mined", status: "active", detail: status ? `alt mempool: ${status.status}` : "waiting for a block" });
      if (status?.status === "Reverted" || status?.status === "Cancelled") throw new Error(`${status.status}: ${status.reason ?? ""}`);
      await new Promise((r) => setTimeout(r, 3_000));
    }
    throw new Error("Not included within 3 minutes. Is the devnet producing blocks?");
  } catch (e) {
    emit({ id: current, status: "failed", detail: e instanceof Error ? e.message : String(e) });
    throw e;
  } finally {
    setIsolationKey(undefined);
  }
}
