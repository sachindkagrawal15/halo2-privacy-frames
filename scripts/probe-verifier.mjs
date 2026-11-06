// Runs the Halo2 verifier on a node without deploying anything: an eth_call with no `to` executes
// a probe constructor that creates the verifier, calls it with a proof, and returns
// (accepted, gasUsed). Works on any node, including one that has stopped producing blocks.
//
//   node scripts/probe-verifier.mjs [rpc-url]
import solc from "solc";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeAbiParameters, encodeAbiParameters, concatHex } from "viem";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.argv[2] ?? "https://altmempool.forshtat.com";

const probeSource = `
pragma solidity 0.8.28;
contract VerifyProbe {
    constructor(bytes memory verifierInitCode, bytes memory input) {
        address verifier;
        assembly { verifier := create(0, add(verifierInitCode, 0x20), mload(verifierInitCode)) }
        require(verifier != address(0), "verifier deployment failed");
        uint256 before = gasleft();
        (bool accepted, ) = verifier.staticcall(input);
        uint256 used = before - gasleft();
        bytes memory out = abi.encode(accepted, used, verifier.code.length);
        assembly { return(add(out, 0x20), mload(out)) }
    }
}`;
const compiled = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources: { "VerifyProbe.sol": { content: probeSource } },
      settings: { evmVersion: "cancun", outputSelection: { "*": { "*": ["evm.bytecode.object"] } } },
    }),
  ),
);
const probe = `0x${compiled.contracts["VerifyProbe.sol"].VerifyProbe.evm.bytecode.object}`;
const verifier = JSON.parse(readFileSync(path.join(root, "contracts/out/Halo2Verifier.json"), "utf8")).bytecode;
const sample = JSON.parse(readFileSync(path.join(root, "circuits/build/sample.json"), "utf8"));

async function run(label, input) {
  const data = concatHex([probe, encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [verifier, input])]);
  const res = await (
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ data, gas: "0x3938700" }, "latest"] }),
    })
  ).json();
  if (res.error) return console.log(`${label}: error ${res.error.message}`);
  const [accepted, used, size] = decodeAbiParameters([{ type: "bool" }, { type: "uint256" }, { type: "uint256" }], res.result);
  console.log(`${label}: accepted=${accepted}, verifier gas ${used}, verifier size ${size} bytes`);
}

await run("valid proof", sample.calldata);
// Flip one public input (the fee, the 4th word): a proof for other inputs must be refused.
const words = sample.calldata.slice(2);
const tampered = `0x${words.slice(0, 64 * 3)}${(BigInt("0x" + words.slice(64 * 3, 64 * 4)) + 1n).toString(16).padStart(64, "0")}${words.slice(64 * 4)}`;
await run("fee changed", tampered);
