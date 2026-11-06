import { poseidon2 } from "poseidon-lite/poseidon2";
import { LEVELS } from "./constants";

/**
 * The deposit tree, rebuilt from `Deposit` events. Same layout as the circuit's merkle.rs and
 * PoseidonMerkleTree.sol: leaves fill left to right and a missing node is the root of an empty
 * subtree, `zeros[level]`, with `zeros[0] = 0`.
 */
export function zeros(levels = LEVELS): bigint[] {
  const z = [0n];
  for (let i = 0; i < levels; i++) z.push(poseidon2([z[i], z[i]]));
  return z;
}

export class MerkleTree {
  private readonly layers: bigint[][];
  private readonly empty: bigint[];

  constructor(leaves: bigint[], private readonly levels = LEVELS) {
    this.empty = zeros(levels);
    this.layers = [leaves];
    for (let level = 0; level < levels; level++) {
      const below = this.layers[level];
      const above: bigint[] = [];
      for (let i = 0; i < below.length; i += 2) above.push(poseidon2([below[i], below[i + 1] ?? this.empty[level]]));
      this.layers.push(above);
    }
  }

  get root(): bigint {
    return this.layers[this.levels][0] ?? this.empty[this.levels];
  }

  /** Sibling hashes from the leaf up: the circuit's `pathElements`. */
  path(index: number): bigint[] {
    if (index < 0 || index >= this.layers[0].length) throw new Error(`no leaf at index ${index}`);
    const siblings: bigint[] = [];
    let node = index;
    for (let level = 0; level < this.levels; level++) {
      siblings.push(this.layers[level][node ^ 1] ?? this.empty[level]);
      node >>= 1;
    }
    return siblings;
  }
}
