// Cross-checks the three implementations before anything touches a chain: notes and the Merkle tree
// in TypeScript (poseidon-lite), proving in the WASM build of the Halo2 circuit, and verification by
// the generated Solidity verifier (run in revm by `ghost-cli gas`).
//
//   npx tsx scripts/wasm-selftest.ts <dir with `wasm-bindgen --target nodejs` output>
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { commitmentOf, createNote, nullifierHashOf, toBytes32 } from "../app/src/lib/note";
import { buildWitness } from "../app/src/lib/witness";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bindings = process.argv[2];
if (!bindings) throw new Error("usage: wasm-selftest.ts <nodejs bindings dir>");
const ghost = createRequire(import.meta.url)(path.resolve(bindings, "ghost.js"));

const seconds = (since: number) => ((performance.now() - since) / 1000).toFixed(1) + " s";
function check(ok: boolean, what: string) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok  ${what}`);
}

const params = readFileSync(path.join(root, "circuits/build/kzg_bn254_15.srs"));
const config = readFileSync(path.join(root, "circuits/build/config.json"), "utf8");
let started = performance.now();
const vkHash: string = ghost.init(params, config);
console.log(`init (keygen in WASM): ${seconds(started)}`);
check(vkHash === JSON.parse(config).vkHash, "WASM keygen reproduces the native verifying key");

const [a, b] = [123456789n, 987654321n];
check(ghost.poseidon2(toBytes32(a), toBytes32(b)) === toBytes32(poseidon2([a, b])), "Rust Poseidon == poseidon-lite");

const notes = [createNote(), createNote(), createNote()];
const recipient = privateKeyToAccount(generatePrivateKey()).address;
const fee = 123_456_789n;
const { witness, root: treeRoot } = buildWitness(notes[1], notes.map(commitmentOf), recipient, fee);

started = performance.now();
const proof = JSON.parse(ghost.prove(JSON.stringify(witness)));
console.log(`prove (single-threaded WASM): ${seconds(started)}, ${(proof.proof.length - 2) / 2} bytes`);
const expected = [treeRoot, nullifierHashOf(notes[1]), BigInt(recipient), fee].map(toBytes32);
check(JSON.stringify(proof.publicInputs) === JSON.stringify(expected), "public inputs match the TypeScript tree and note");

const dir = mkdtempSync(path.join(tmpdir(), "h2pf-"));
writeFileSync(path.join(dir, "proof.json"), JSON.stringify(proof));
const gas = execFileSync(path.join(root, "circuits/target/release/ghost-cli"), [
  "gas",
  path.join(root, "circuits/build/GhostVerifier.bytecode.hex"),
  path.join(dir, "proof.json"),
], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
check(Number(gas) > 0, `Solidity verifier accepts the WASM proof (${gas} gas)`);
