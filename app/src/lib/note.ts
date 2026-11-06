import { poseidon2 } from "poseidon-lite/poseidon2";
import { getAddress, type Address } from "viem";

/** A deposit's secrets. Whoever holds them can withdraw the deposit, so they never leave the device. */
export interface Note {
  nullifier: bigint;
  secret: bigint;
}

const NOTE_PREFIX = "h2pf-v1";
const FIELD_HEX = 62; // 31 bytes: always below the BN254 field modulus

export function randomField(): bigint {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  return BigInt("0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
}

export const createNote = (): Note => ({ nullifier: randomField(), secret: randomField() });

/** The tree leaf a deposit inserts: Poseidon(nullifier, secret). */
export const commitmentOf = (note: Note): bigint => poseidon2([note.nullifier, note.secret]);

/** Revealed by the withdrawal to block double spends: Poseidon(nullifier, 1). */
export const nullifierHashOf = (note: Note): bigint => poseidon2([note.nullifier, 1n]);

export const toBytes32 = (x: bigint): `0x${string}` => `0x${x.toString(16).padStart(64, "0")}`;

/** `h2pf-v1-<chainId>-<pool>-<nullifier><secret>`, the string a depositor saves. */
export function encodeNote(note: Note, chainId: number, pool: Address): string {
  const field = (x: bigint) => x.toString(16).padStart(FIELD_HEX, "0");
  return `${NOTE_PREFIX}-${chainId}-${pool.toLowerCase()}-0x${field(note.nullifier)}${field(note.secret)}`;
}

export function decodeNote(text: string): { note: Note; chainId: number; pool: Address } {
  // Notes saved before the project was renamed start with `ghostframe-v1`.
  const match = text.trim().match(/^(?:h2pf|ghostframe)-v1-(\d+)-(0x[0-9a-fA-F]{40})-0x([0-9a-fA-F]{124})$/);
  if (!match) throw new Error("That is not a Halo2 Privacy Frames note.");
  const [, chainId, pool, secrets] = match;
  return {
    chainId: Number(chainId),
    pool: getAddress(pool),
    note: {
      nullifier: BigInt("0x" + secrets.slice(0, FIELD_HEX)),
      secret: BigInt("0x" + secrets.slice(FIELD_HEX)),
    },
  };
}
