import type { Hex } from "viem";
import type { WitnessJson } from "../lib/witness";

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, Pending>();

function prover(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent) => {
      const { id, type, ...rest } = event.data;
      const call = pending.get(id);
      if (!call) return;
      pending.delete(id);
      if (type === "error") call.reject(new Error(rest.message));
      else call.resolve(rest);
    };
  }
  return worker;
}

function call(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    prover().postMessage({ id, ...message });
  });
}

let ready: Promise<string> | undefined;

/** Loads the WASM prover and runs keygen (a few seconds). Safe to call early and often. */
export function prepareProver(): Promise<string> {
  ready ??= call({
    type: "init",
    // Absolute URLs: the worker resolves relative ones against its own script, not the page.
    paramsUrl: new URL("zk/kzg_bn254_15.srs", document.baseURI).href,
    configUrl: new URL("zk/config.json", document.baseURI).href,
  })
    .then((r) => r.vkHash as string)
    .catch((e) => {
      ready = undefined;
      throw e;
    });
  return ready;
}

export interface ProofResult {
  proof: Hex;
  publicInputs: Hex[];
  ms: number;
}

export async function proveWithdrawal(witness: WitnessJson): Promise<ProofResult> {
  await prepareProver();
  return (await call({ type: "prove", witness })) as unknown as ProofResult;
}
