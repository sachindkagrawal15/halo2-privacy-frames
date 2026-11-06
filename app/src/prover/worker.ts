/// <reference lib="webworker" />
// Runs the Halo2 prover (Rust compiled to WASM) off the main thread. The note's secrets arrive here
// as part of the witness and never leave the browser.
import initWasm, { init, prove } from "../wasm/ghost.js";
import wasmUrl from "../wasm/ghost_bg.wasm?url";

let ready: Promise<string> | undefined;

async function load(paramsUrl: string, configUrl: string): Promise<string> {
  await initWasm({ module_or_path: wasmUrl });
  const [params, config] = await Promise.all([
    fetch(paramsUrl).then((r) => {
      if (!r.ok) throw new Error(`KZG parameters: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch(configUrl).then((r) => {
      if (!r.ok) throw new Error(`circuit config: HTTP ${r.status}`);
      return r.text();
    }),
  ]);
  // Keygen: rebuilds the proving key from the public parameters and checks it matches the
  // verifying key baked into the on-chain verifier.
  return init(new Uint8Array(params), config);
}

self.onmessage = async (event: MessageEvent) => {
  const { id, type } = event.data;
  try {
    if (type === "init") {
      ready ??= load(event.data.paramsUrl, event.data.configUrl);
      self.postMessage({ id, type: "ready", vkHash: await ready });
    } else if (type === "prove") {
      if (!ready) throw new Error("the prover is not initialised");
      await ready;
      const started = performance.now();
      const result = JSON.parse(prove(JSON.stringify(event.data.witness)));
      self.postMessage({ id, type: "proof", ...result, ms: performance.now() - started });
    }
  } catch (e) {
    if (type === "init") ready = undefined;
    self.postMessage({ id, type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
