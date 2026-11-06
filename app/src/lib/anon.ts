import { AnonRpcWorker } from "@anon-rpc/browser-harness";
import { GATEWAY_URL } from "./constants";
import { setTransport } from "./rpc";

/**
 * Anon-RPC networks from ethereum/anon-rpc's adopters list. Each is a hash-pinned client bundle,
 * named by a specifier contract and run in a sandboxed iframe by the harness. The specifier lives on
 * `bootstrapRpc`'s chain; the anonymized fetch can reach any URL, including this devnet.
 */
export interface AnonNetwork {
  id: "tor" | "nox" | "nym";
  label: string;
  specifier: string;
  bootstrapRpc: string;
  config?: { gateways: string[] };
}

/** The default: the network that connected reliably while this was built (Tor's demo gateway did not). */
export const DEFAULT_NETWORK = "nox";

export const ANON_NETWORKS: AnonNetwork[] = [
  {
    id: "nox",
    label: "Nox mixnet",
    specifier: "0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A",
    // Nox's specifier is on Sepolia; requests can still go anywhere, the devnet included.
    bootstrapRpc: "https://ethereum-sepolia-rpc.publicnode.com",
  },
  {
    id: "tor",
    label: "Tor",
    specifier: "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e",
    bootstrapRpc: "https://ethereum-rpc.publicnode.com",
    // The demo gateway from the adopters list: browsers cannot open raw TCP, so it relays blindly into Tor.
    config: { gateways: ["152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ"] },
  },
  {
    id: "nym",
    label: "Nym mixnet",
    specifier: "0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0",
    bootstrapRpc: "https://ethereum-rpc.publicnode.com",
  },
];

export type PrivacyState =
  | { status: "connecting"; network: AnonNetwork }
  | { status: "ready"; network: AnonNetwork }
  | { status: "failed"; network: AnonNetwork; reason: string }
  | { status: "direct" };

let state: PrivacyState = { status: "direct" };
const listeners = new Set<(s: PrivacyState) => void>();

export const privacyState = () => state;

export function onPrivacyChange(listener: (s: PrivacyState) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(next: PrivacyState) {
  state = next;
  for (const listener of listeners) listener(next);
}

/**
 * Calls under different isolation keys should look like they come from unrelated clients. The
 * withdrawal flow uses the note's nullifier hash and the deposit flow the depositor's address, so
 * the network path cannot tie a withdrawal to the deposit that funded it.
 */
let isolationKey: string | undefined;
export const setIsolationKey = (key?: string) => {
  isolationKey = key;
};

/** The only read that is not anonymized: the bootstrap fetch of the specifier's pinned bundle hash. */
function bootstrapProvider(url: string) {
  return {
    async request({ method, params }: { method: string; params?: unknown }) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
      });
      const body = await res.json();
      if (body.error) throw new Error(body.error.message);
      return body.result;
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms)),
  ]);
}

let worker: AnonRpcWorker | undefined;

/**
 * Routes every request through `network`, or directly when `network` is null. While the network is
 * still connecting, requests wait for it; if it fails, they fail too. Falling back to a direct
 * connection is a choice the user makes, never something the page does behind their back.
 */
export async function routeThrough(network: AnonNetwork | null, timeoutMs = 90_000) {
  worker?.close();
  worker = undefined;
  if (!network) {
    setTransport((input, init) => fetch(input, init), "direct");
    publish({ status: "direct" });
    return;
  }

  publish({ status: "connecting", network });
  const w = new AnonRpcWorker({
    address: network.specifier,
    config: network.config,
    preExisting: { rpcProvider: bootstrapProvider(network.bootstrapRpc) },
  });
  worker = w;
  const connected = (async () => {
    await withTimeout(w.ready, timeoutMs, `${network.label} bootstrap`);
    // One real round trip to the devnet proves the whole path works before anything depends on it.
    const probe = await withTimeout(
      w.fetch(GATEWAY_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      }),
      timeoutMs,
      `first request over ${network.label}`,
    );
    await probe.json();
  })();
  connected.catch(() => undefined); // reported through publish below

  setTransport(async (input, init) => {
    await connected;
    return w.fetch(input, { ...init, anonOptions: isolationKey ? { isolationKey } : undefined });
  }, network.label);

  try {
    await connected;
    if (worker === w) publish({ status: "ready", network });
  } catch (e) {
    if (worker === w) publish({ status: "failed", network, reason: e instanceof Error ? e.message : String(e) });
  }
}
