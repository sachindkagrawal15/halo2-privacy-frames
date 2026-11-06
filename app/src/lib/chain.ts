import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbiItem,
  type Address,
  type Hex,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { CHAIN_ID, GATEWAY_URL } from "./constants";
import { appFetch, rpc } from "./rpc";

export const devnet = defineChain({
  id: CHAIN_ID,
  name: "EIP-8141 alt-mempool devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [GATEWAY_URL] } },
});

// viem gets the app's fetch, so its reads and broadcasts take the same (anonymized) path as everything else.
const transport = () => http(GATEWAY_URL, { fetchFn: (input, init) => appFetch(String(input), init), retryCount: 1 });

export const publicClient = createPublicClient({ chain: devnet, transport: transport(), pollingInterval: 3_000 });

export const walletClient = (account: PrivateKeyAccount) =>
  createWalletClient({ account, chain: devnet, transport: transport() });

/** Legacy transactions: the devnet base fee is 7 wei, so this clears it with room to spare. */
export const LEGACY_GAS_PRICE = 2_000_000n;

/** 1 devnet ETH, at most once per hour per address. */
export const requestFaucet = (address: Address) => rpc(GATEWAY_URL, "skandha_explorer_faucet", [address]);

const depositEvent = parseAbiItem("event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)");

/** Every commitment in the pool, in tree order. */
export async function fetchCommitments(pool: Address, fromBlock: bigint): Promise<bigint[]> {
  const logs = await publicClient.getLogs({ address: pool, event: depositEvent, fromBlock, toBlock: "latest" });
  return logs
    .sort((a, b) => Number(a.args.leafIndex) - Number(b.args.leafIndex))
    .map((log) => BigInt(log.args.commitment as Hex));
}
