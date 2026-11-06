// Checks, on the devnet's ethrex, the frame opcodes GhostPool's validation relies on but that EF's
// hegota-support has only taken from the EIP text for this devnet: TXPARAM, FRAMEPARAM, FRAMEDATALOAD.
// A dry run (ethrex_simulateFrameTransaction, nothing is mined) of
//   frame 0  DEFAULT  Arachnid's proxy deploys FrameProbe at tx.sender
//   frame 1  VERIFY   FrameProbe reads what GhostPool reads about the last frame, and reverts with it
//   frame 2  SENDER   a withdraw-shaped call with known calldata and limits
//
//   npx tsx scripts/probe-frames.ts
import solc from "solc";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { concatHex, decodeAbiParameters, encodeFunctionData, getContractAddress, type Address, type Hex } from "viem";
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { frame, newTx } from "@forshtat/hegota-support/tx";
import { ghostPoolAbi } from "../app/src/lib/abi.generated";
import { CHAIN_ID } from "../app/src/lib/constants";
import { simulate } from "../app/src/lib/frames";
import { randomField, toBytes32 } from "../app/src/lib/note";
import { repoRoot } from "./lib/devnet";

const PROXY: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

const source = `
pragma solidity 0.8.28;
import {HegotaSupport, Devnet, TxParam, FrameParam} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
contract FrameProbe is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    fallback() external payable {
        uint256 f = txparam(TxParam.FRAME_COUNT) - 1;
        bytes memory a = abi.encode(
            txparam(TxParam.FRAME_COUNT),
            txparam(TxParam.CURRENT_FRAME_INDEX),
            txparam(TxParam.MAX_COST),
            frameparam(f, FrameParam.MODE),
            frameparam(f, FrameParam.RESOLVED_TARGET),
            frameparam(f, FrameParam.VALUE)
        );
        bytes memory b = abi.encode(
            frameparam(f, FrameParam.DATA_LENGTH),
            frameparam(f, FrameParam.EXECUTION_GAS_LIMIT),
            frameparam(f, FrameParam.STATE_GAS_LIMIT),
            framedataload(0, f),
            framedataload(4, f),
            framedataload(36, f),
            framedataload(68, f)
        );
        bytes memory out = bytes.concat(a, b);
        assembly { revert(add(out, 0x20), mload(out)) }
    }
}`;

function findImports(importPath: string) {
  const file = path.join(repoRoot, "node_modules", importPath);
  return existsSync(file) ? { contents: readFileSync(file, "utf8") } : { error: `not found: ${importPath}` };
}
const compiled = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources: { "FrameProbe.sol": { content: source } },
      settings: { evmVersion: "cancun", viaIR: true, optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["evm.bytecode.object"] } } },
    }),
    { import: findImports },
  ),
);
const errors = (compiled.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
const probeInit = `0x${compiled.contracts["FrameProbe.sol"].FrameProbe.evm.bytecode.object}` as Hex;

const salt = toBytes32(randomField());
const sender = getContractAddress({ opcode: "CREATE2", from: PROXY, salt, bytecode: probeInit });
const target: Address = "0x8943545177806ED17B9F23F0a21ee5948eCaa776";
const nullifierHash = toBytes32(randomField());
const recipient: Address = "0x1111111111111111111111111111111111111111";
const fee = 123_456_789_000n;
const senderData = encodeFunctionData({ abi: ghostPoolAbi, functionName: "withdraw", args: [nullifierHash, recipient, fee] });
const limits = { execution: 100_000n, state: 450_000n };

const tx = newTx({
  chainId: CHAIN_ID,
  sender,
  nonceSeq: 0n,
  signatures: [],
  fees: { maxFeePerGas: BigInt(process.env.PROBE_MAX_FEE ?? 0) },
  frames: [
    frame(profile, "DEFAULT", { target: PROXY, execution: 8_000_000n, state: 8_000_000n, data: concatHex([salt, probeInit]) }),
    frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 500_000n }),
    frame(profile, "SENDER", { target, ...limits, data: senderData }),
  ],
});

const sim = await simulate(tx);
console.log(`prefix ${sim.prefixShape}, failed frame ${sim.failedFrameIndex}, ${sim.executionError ?? sim.haltReason ?? ""}`);
if (!sim.revertData || sim.revertData === "0x") {
  console.log(JSON.stringify(sim, null, 1));
  throw new Error("the VERIFY frame did not report its readings");
}
const words = decodeAbiParameters(Array(13).fill({ type: "uint256" }), sim.revertData) as readonly bigint[];
const word = (x: bigint) => toBytes32(x);
const checks: [string, string, string][] = [
  ["TXPARAM(FRAME_COUNT)", String(words[0]), "3"],
  ["TXPARAM(CURRENT_FRAME_INDEX)", String(words[1]), "1"],
  ["TXPARAM(MAX_COST)", String(words[2]), String(BigInt(sim.maxCost))],
  ["FRAMEPARAM(2, MODE)", String(words[3]), "2"],
  ["FRAMEPARAM(2, RESOLVED_TARGET)", word(words[4]), word(BigInt(target))],
  ["FRAMEPARAM(2, VALUE)", String(words[5]), "0"],
  ["FRAMEPARAM(2, DATA_LENGTH)", String(words[6]), String((senderData.length - 2) / 2)],
  ["FRAMEPARAM(2, EXECUTION_GAS_LIMIT)", String(words[7]), String(limits.execution)],
  ["FRAMEPARAM(2, STATE_GAS_LIMIT)", String(words[8]), String(limits.state)],
  ["FRAMEDATALOAD(0, 2) selector word", word(words[9]).slice(0, 10), senderData.slice(0, 10)],
  ["FRAMEDATALOAD(4, 2) nullifierHash", word(words[10]), nullifierHash],
  ["FRAMEDATALOAD(36, 2) recipient", word(words[11]), word(BigInt(recipient))],
  ["FRAMEDATALOAD(68, 2) fee", String(words[12]), String(fee)],
];
let ok = true;
for (const [name, got, want] of checks) {
  const match = got === want;
  ok &&= match;
  console.log(`${match ? "ok " : "BAD"} ${name}: ${got}${match ? "" : ` (expected ${want})`}`);
}
if (!ok) process.exitCode = 1;
