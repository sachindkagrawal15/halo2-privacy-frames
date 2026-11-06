import type { Address } from "viem";
import raw from "../deployment.json";

/** Written by scripts/deploy.ts. `pool` is null until the contracts are on the devnet. */
export interface Deployment {
  chainId: number;
  pool: Address | null;
  verifier?: Address;
  poseidon?: Address;
  denomination: string;
  deployedAtBlock: number;
}

export const deployment = raw as Deployment;
export const denomination = BigInt(deployment.denomination);
