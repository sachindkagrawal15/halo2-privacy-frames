// The EF alt-mempool devnet (EIP-8141 frame transactions). It is a public throwaway network that
// can be reset at any time: see https://docs.altmempool.wtf/guides/devnet/
export const CHAIN_ID = 1337;
/** The sidecar gateway: frame transactions into the ERC-8421 alt mempool, plus proxied eth_* reads. */
export const GATEWAY_URL = "https://altmempoolgateway.forshtat.com/rpc";
/** ethrex itself: the canonical EIP-8141 mempool and ethrex_simulateFrameTransaction. */
export const ETHREX_URL = "https://altmempool.forshtat.com";
export const EXPLORER_URL = "https://explorer.altmempool.wtf/";
/** ERC-8421 NaiveStakingRegistry on the devnet; keyed by msg.sender. */
export const STAKING_REGISTRY = "0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f";

/**
 * The alternative-mempool node withdrawals are sent to: the devnet's gateway, unless you run your own
 * (scripts/local-mempool.sh) and pass it as H2PF_MEMPOOL_URL to the scripts or ?mempool= to the app.
 */
export const MEMPOOL_URL: string =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.H2PF_MEMPOOL_URL ??
  (typeof location === "undefined" ? null : new URLSearchParams(location.search).get("mempool")) ??
  GATEWAY_URL;

/** Must match `LEVELS` in the circuit and in PoseidonMerkleTree.sol. */
export const LEVELS = 20;
export const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
