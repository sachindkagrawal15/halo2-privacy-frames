// Measures, on the devnet's ethrex, what the withdrawal frame pays for: a new storage slot (the
// nullifier), an overwritten slot, and ETH sent to an address that has no account yet.
//
//   npx tsx scripts/probe-gas.ts
import solc from "solc";
import { concatHex, decodeAbiParameters, type Address, type Hex } from "viem";
import { ETHREX_URL } from "../app/src/lib/constants";

const FROM: Address = "0x5544596212F91984C986A919C8026DF0576816f9";

const source = `
pragma solidity 0.8.28;
contract GasProbe {
    mapping(uint256 => uint256) slots;
    constructor() payable {
        slots[1] = 1; // make slot 1 exist before measuring an overwrite
        uint256 a = gasleft();
        slots[2] = 1;                       // zero -> non-zero: a new slot
        uint256 b = gasleft();
        slots[1] = 2;                       // non-zero -> non-zero
        uint256 c = gasleft();
        (bool sent, ) = payable(address(uint160(uint256(keccak256(abi.encode(block.number, gasleft())))))).call{value: 1}("");
        uint256 d = gasleft();
        (bool sent2, ) = payable(address(uint160(uint256(keccak256(abi.encode(block.number, gasleft())))))).call{value: 1, gas: 30000}("");
        uint256 e = gasleft();
        bytes memory out = abi.encode(a - b, b - c, sent, c - d, sent2, d - e);
        assembly { return(add(out, 0x20), mload(out)) }
    }
}`;
const out = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources: { "GasProbe.sol": { content: source } },
      settings: { evmVersion: "cancun", outputSelection: { "*": { "*": ["evm.bytecode.object"] } } },
    }),
  ),
);
const bytecode = `0x${out.contracts["GasProbe.sol"].GasProbe.evm.bytecode.object}` as Hex;

const response = await (
  await fetch(ETHREX_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from: FROM, data: concatHex([bytecode]), value: "0x2", gas: "0x1c9c380" }, "latest"] }),
  })
).json();
if (response.error) throw new Error(JSON.stringify(response.error));
const [newSlot, overwrite, sent, newAccount, sent2, newAccountCapped] = decodeAbiParameters(
  [{ type: "uint256" }, { type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "bool" }, { type: "uint256" }],
  response.result,
);
console.log(`SSTORE zero -> non-zero (new slot):  ${newSlot} gas`);
console.log(`SSTORE non-zero -> non-zero:          ${overwrite} gas`);
console.log(`1 wei to a new account (all gas):      ${newAccount} gas, delivered=${sent}`);
console.log(`1 wei to a new account (30k gas cap):  ${newAccountCapped} gas, delivered=${sent2}`);
