// Bisects a failing constructor on the devnet's ethrex: creates each candidate inside one eth_call and
// reports, per candidate, whether CREATE succeeded, the gas it burned and the size of its revert data.
//
//   npx tsx scripts/probe-create.ts
import solc from "solc";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  concatHex,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeDeployData,
  getContractAddress,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { ETHREX_URL, STAKING_REGISTRY } from "../app/src/lib/constants";
import { randomField, toBytes32 } from "../app/src/lib/note";
import { artifact, link, repoRoot } from "./lib/devnet";

const PROXY: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const FROM: Address = "0x5544596212F91984C986A919C8026DF0576816f9";

function findImports(importPath: string) {
  for (const base of [path.join(repoRoot, "contracts"), path.join(repoRoot, "node_modules")]) {
    const file = path.join(base, importPath);
    if (existsSync(file)) return { contents: readFileSync(file, "utf8") };
  }
  return { error: `not found: ${importPath}` };
}

function compile(sources: Record<string, string>, names: string[]) {
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, { content: v }])),
        settings: {
          evmVersion: "cancun",
          viaIR: true,
          optimizer: { enabled: true, runs: 200 },
          outputSelection: { "*": { "*": ["evm.bytecode.object", "evm.bytecode.linkReferences"] } },
        },
      }),
      { import: findImports },
    ),
  );
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  const found: Record<string, { bytecode: Hex; linkReferences: Record<string, Record<string, { start: number; length: number }[]>> }> = {};
  for (const unit of Object.values(out.contracts) as Record<string, any>[]) {
    for (const [name, c] of Object.entries(unit)) {
      if (names.includes(name)) found[name] = { bytecode: `0x${c.evm.bytecode.object}`, linkReferences: c.evm.bytecode.linkReferences };
    }
  }
  return found;
}

const candidates = compile(
  {
    "Candidates.sol": `
pragma solidity 0.8.28;
import {HegotaSupport, Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {PoseidonMerkleTree} from "src/PoseidonMerkleTree.sol";
contract HegotaOnly is HegotaSupport(Devnet.ERC8421_WORKSHOP) {}
contract TreeOnly is PoseidonMerkleTree {}
`,
  },
  ["HegotaOnly", "TreeOnly"],
);

const probe = compile(
  {
    "CreateProbe.sol": `
pragma solidity 0.8.28;
contract CreateProbe {
    constructor(bytes32 salt, bytes memory poseidonInit, bytes[] memory inits) payable {
        (bool ok, ) = ${PROXY}.call(abi.encodePacked(salt, poseidonInit));
        require(ok, "PoseidonT3 deployment failed");
        bool[] memory created = new bool[](inits.length);
        uint256[] memory gasUsed = new uint256[](inits.length);
        uint256[] memory revertSize = new uint256[](inits.length);
        for (uint256 i = 0; i < inits.length; i++) {
            bytes memory code = inits[i];
            uint256 before = gasleft();
            address a;
            uint256 size;
            assembly {
                a := create(0, add(code, 0x20), mload(code))
                size := returndatasize()
            }
            gasUsed[i] = before - gasleft();
            created[i] = a != address(0);
            revertSize[i] = size;
        }
        bytes memory out = abi.encode(created, gasUsed, revertSize, gasleft());
        assembly { return(add(out, 0x20), mload(out)) }
    }
}`,
  },
  ["CreateProbe"],
).CreateProbe.bytecode;

const salt = toBytes32(randomField());
const poseidon = artifact("PoseidonT3");
const poseidonAddress = getContractAddress({ opcode: "CREATE2", from: PROXY, salt, bytecode: poseidon.bytecode });
const libs = { "poseidon-solidity/PoseidonT3.sol:PoseidonT3": poseidonAddress };
const pool = artifact("GhostPool");
const inits: [string, Hex][] = [
  ["HegotaOnly (7 opcode helpers)", candidates.HegotaOnly.bytecode],
  ["TreeOnly (zeros: 20 Poseidon hashes, 41 new slots)", link({ ...candidates.TreeOnly, abi: [] }, libs)],
  [
    "GhostPool (no stake)",
    encodeDeployData({
      abi: pool.abi,
      bytecode: link(pool, libs),
      args: ["0x0000000000000000000000000000000000000001", parseEther("0.1"), 60_000n, 250_000n, STAKING_REGISTRY, 86_400],
    }),
  ],
];

const gas = BigInt(process.env.PROBE_GAS ?? 50_000_000);
const data = concatHex([
  probe,
  encodeAbiParameters([{ type: "bytes32" }, { type: "bytes" }, { type: "bytes[]" }], [salt, poseidon.bytecode, inits.map(([, c]) => c)]),
]);
const response = await (
  await fetch(ETHREX_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from: FROM, data, gas: `0x${gas.toString(16)}` }, "latest"] }),
  })
).json();
if (response.error) throw new Error(`eth_call failed: ${JSON.stringify(response.error)}`);
const [created, gasUsed, revertSize, left] = decodeAbiParameters(
  [{ type: "bool[]" }, { type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256" }],
  response.result,
);
inits.forEach(([name], i) =>
  console.log(`${created[i] ? "ok  " : "FAIL"} ${name}: ${gasUsed[i]} gas${created[i] ? "" : `, revert data ${revertSize[i]} bytes`}`),
);
console.log(`gas left in the call: ${left} (of ${gas})`);
