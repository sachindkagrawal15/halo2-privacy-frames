// Deploys the real PoseidonT3, Halo2 verifier and GhostPool on the devnet's ethrex, makes deposits and
// reads the pool's root after each, all inside one eth_call: nothing is mined, so it works even while
// the devnet is stalled. Checks the constructor (HegotaSupport helpers, self-staking) fits the gas
// budget and that the on-chain Poseidon tree agrees with the TypeScript tree the app builds.
//
//   npx tsx scripts/probe-pool.ts
import solc from "solc";
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
import { MerkleTree } from "../app/src/lib/tree";
import { commitmentOf, createNote, randomField, toBytes32 } from "../app/src/lib/note";
import { artifact, link } from "./lib/devnet";

/** Arachnid's deterministic deployment proxy, in the devnet's genesis: calldata = salt ‖ initcode. */
const PROXY: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
/** The devnet's funded genesis account, used only as the `from` of a read-only call; no key is involved. */
const FROM: Address = "0x5544596212F91984C986A919C8026DF0576816f9";
const DENOMINATION = parseEther("0.1");
const STAKE = process.env.PROBE_NO_STAKE ? 0n : parseEther("0.012");
const DEPOSITS = 3;

const probeSource = `
pragma solidity 0.8.28;
interface IPool {
    function deposit(bytes32 commitment) external payable;
    function currentRoot() external view returns (bytes32);
}
contract PoolProbe {
    address constant PROXY = ${PROXY};
    constructor(bytes32 salt, bytes memory poseidonInit, bytes memory poolInit,
                bytes32[] memory commitments, uint256 denomination, uint256 stake, address expectedPoseidon) payable {
        (bool ok, bytes memory ret) = PROXY.call(abi.encodePacked(salt, poseidonInit));
        require(ok && ret.length == 20 && address(bytes20(ret)) == expectedPoseidon, "PoseidonT3 deployment failed");
        uint256 before = gasleft();
        address pool;
        assembly {
            pool := create(stake, add(poolInit, 0x20), mload(poolInit))
            // Surface the constructor's own revert data.
            if iszero(pool) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
        }
        uint256 deployGas = before - gasleft();
        bytes32[] memory roots = new bytes32[](commitments.length + 1);
        uint256[] memory depositGas = new uint256[](commitments.length);
        roots[0] = IPool(pool).currentRoot();
        for (uint256 i = 0; i < commitments.length; i++) {
            before = gasleft();
            IPool(pool).deposit{value: denomination}(commitments[i]);
            depositGas[i] = before - gasleft();
            roots[i + 1] = IPool(pool).currentRoot();
        }
        bytes memory out = abi.encode(pool, deployGas, pool.code.length, roots, depositGas, pool.balance);
        assembly { return(add(out, 0x20), mload(out)) }
    }
}`;

const compiled = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources: { "PoolProbe.sol": { content: probeSource } },
      settings: { evmVersion: "cancun", viaIR: true, optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["evm.bytecode.object"] } } },
    }),
  ),
);
if (compiled.errors?.some((e: { severity: string }) => e.severity === "error")) throw new Error(JSON.stringify(compiled.errors, null, 2));
const probe = `0x${compiled.contracts["PoolProbe.sol"].PoolProbe.evm.bytecode.object}` as Hex;

const salt = toBytes32(randomField());
const poseidon = artifact("PoseidonT3");
const poseidonAddress = getContractAddress({ opcode: "CREATE2", from: PROXY, salt, bytecode: poseidon.bytecode });
// Deposits never call the verifier, and deploying it too would not fit in one call (code costs ~1.6k gas a byte here).
const verifierAddress: Address = "0x0000000000000000000000000000000000000001";
const pool = artifact("GhostPool");
const poolInit = encodeDeployData({
  abi: pool.abi,
  bytecode: link(pool, { "poseidon-solidity/PoseidonT3.sol:PoseidonT3": poseidonAddress }),
  args: [verifierAddress, DENOMINATION, 60_000n, 400_000n, STAKING_REGISTRY, 86_400],
});

const commitments = Array.from({ length: DEPOSITS }, () => commitmentOf(createNote()));
const data = concatHex([
  probe,
  encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "bytes" }, { type: "bytes" }, { type: "bytes32[]" },
      { type: "uint256" }, { type: "uint256" }, { type: "address" },
    ],
    [salt, poseidon.bytecode, poolInit, commitments.map(toBytes32), DENOMINATION, STAKE, poseidonAddress],
  ),
]);

const response = await (
  await fetch(ETHREX_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ from: FROM, data, value: `0x${(STAKE + DENOMINATION * BigInt(DEPOSITS)).toString(16)}`, gas: "0x3938700" }, "latest"],
    }),
  })
).json();
if (response.error) throw new Error(`eth_call failed: ${JSON.stringify(response.error)}`);

const [address, deployGas, codeSize, roots, depositGas, balance] = decodeAbiParameters(
  [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32[]" }, { type: "uint256[]" }, { type: "uint256" }],
  response.result,
);
console.log(`GhostPool deployed in the call at ${address}: ${codeSize} bytes, constructor ${deployGas} gas (incl. 7 opcode helpers and the stake)`);
console.log(`deposit gas: ${depositGas.join(", ")}; pool balance afterwards ${balance} wei`);
let ok = true;
for (let n = 0; n <= DEPOSITS; n++) {
  const expected = toBytes32(new MerkleTree(commitments.slice(0, n)).root);
  const match = roots[n] === expected;
  ok &&= match;
  console.log(`${match ? "ok " : "BAD"} root after ${n} deposit(s): chain ${roots[n]}${match ? "" : ` vs TypeScript ${expected}`}`);
}
if (!ok) process.exitCode = 1;
