// Node-side helpers for the deploy and end-to-end scripts. The key they use is a throwaway devnet key
// kept in devnet.state.json (git-ignored); never reuse it on a real network.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { CHAIN_ID, GATEWAY_URL } from "../../app/src/lib/constants";
import { rpc } from "../../app/src/lib/rpc";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const devnet = defineChain({
  id: CHAIN_ID,
  name: "EIP-8141 alt-mempool devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [GATEWAY_URL] } },
});

export const publicClient = createPublicClient({ chain: devnet, transport: http(GATEWAY_URL) });

/** Legacy transactions (deployments, deposits): the devnet base fee is 7 wei, so this clears it easily. */
export const LEGACY_GAS_PRICE = 2_000_000n;

const STATE_FILE = path.join(repoRoot, "devnet.state.json");

interface State {
  key: Hex;
}

export function account(): PrivateKeyAccount {
  let state: State;
  if (existsSync(STATE_FILE)) {
    state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } else {
    state = { key: generatePrivateKey() };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  }
  return privateKeyToAccount(state.key);
}

export const walletClient = (acct: PrivateKeyAccount) =>
  createWalletClient({ account: acct, chain: devnet, transport: http(GATEWAY_URL) });

/** Tops `address` up from the devnet faucet (1 ETH, once per hour per address) when it is below `min`. */
export async function ensureFunds(address: Address, min: bigint) {
  const before = await publicClient.getBalance({ address });
  if (before >= min) return before;
  console.log(`funding ${address} from the faucet`);
  await rpc(GATEWAY_URL, "skandha_explorer_faucet", [address]);
  for (let i = 0; i < 40; i++) {
    const balance = await publicClient.getBalance({ address });
    if (balance > before) return balance;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("the faucet did not pay out within 2 minutes; is the devnet producing blocks?");
}

interface Artifact {
  abi: Abi;
  bytecode: Hex;
  linkReferences: Record<string, Record<string, { start: number; length: number }[]>>;
}

export const artifact = (name: string): Artifact =>
  JSON.parse(readFileSync(path.join(repoRoot, "contracts/out", `${name}.json`), "utf8"));

/** Replaces solc's `__$…$__` placeholders with deployed library addresses. */
export function link(a: Artifact, libraries: Record<string, Address>): Hex {
  let code = a.bytecode.slice(2);
  for (const [file, libs] of Object.entries(a.linkReferences ?? {})) {
    for (const [name, refs] of Object.entries(libs)) {
      const address = libraries[`${file}:${name}`];
      if (!address) throw new Error(`no address for library ${file}:${name}`);
      for (const { start, length } of refs) {
        code = code.slice(0, start * 2) + address.slice(2).toLowerCase() + code.slice((start + length) * 2);
      }
    }
  }
  return `0x${code}`;
}

/** Deploys with a legacy transaction and waits for it to be mined. */
export async function deploy(
  acct: PrivateKeyAccount,
  name: string,
  opts: { args?: unknown[]; value?: bigint; libraries?: Record<string, Address>; gas?: bigint } = {},
): Promise<{ address: Address; block: bigint }> {
  const a = artifact(name);
  const bytecode = opts.libraries ? link(a, opts.libraries) : a.bytecode;
  const wallet = walletClient(acct);
  const hash = await wallet.deployContract({
    abi: a.abi,
    bytecode,
    args: opts.args ?? [],
    value: opts.value,
    type: "legacy",
    gasPrice: LEGACY_GAS_PRICE,
    // Contract creation is charged state gas on this devnet, by the byte of code; the block limit is 60M.
    gas: opts.gas ?? 30_000_000n,
  } as Parameters<typeof wallet.deployContract>[0]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${name}: deployment ${hash} failed`);
  console.log(`${name}: ${receipt.contractAddress} (block ${receipt.blockNumber}, ${receipt.gasUsed} gas)`);
  return { address: receipt.contractAddress, block: receipt.blockNumber };
}
