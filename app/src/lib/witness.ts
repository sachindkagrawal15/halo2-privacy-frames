import type { Address } from "viem";
import { MerkleTree } from "./tree";
import { commitmentOf, toBytes32, type Note } from "./note";

/** The JSON the Halo2 prover reads (ghost-circuit's `WithdrawWitness::from_json`). */
export interface WitnessJson {
  nullifier: string;
  secret: string;
  leafIndex: number;
  pathElements: string[];
  recipient: string;
  fee: string;
}

/** Finds the note's deposit among all leaves and assembles everything the prover needs. */
export function buildWitness(note: Note, leaves: bigint[], recipient: Address, fee: bigint) {
  const leafIndex = leaves.indexOf(commitmentOf(note));
  if (leafIndex < 0) throw new Error("This note's deposit is not in the pool.");
  const tree = new MerkleTree(leaves);
  const witness: WitnessJson = {
    nullifier: toBytes32(note.nullifier),
    secret: toBytes32(note.secret),
    leafIndex,
    pathElements: tree.path(leafIndex).map(toBytes32),
    recipient,
    fee: fee.toString(),
  };
  return { witness, root: tree.root, leafIndex };
}
