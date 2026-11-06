// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";

/// @notice Append-only Poseidon Merkle tree of deposit commitments, depth 20.
/// @dev Same layout as the circuit's `merkle.rs`: leaves fill left to right, a missing node is the root
/// of an empty subtree (`zeros[level]`, with `zeros[0] = 0`), and the hash is circomlib's Poseidon(2).
/// Every root the tree ever had stays valid: a proof against an older root proves membership in a
/// subset of today's tree, and validation reads a single storage slot instead of scanning a history.
abstract contract PoseidonMerkleTree {
    uint256 internal constant FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint32 public constant LEVELS = 20;

    mapping(uint256 level => bytes32) public filledSubtrees;
    mapping(uint256 level => bytes32) public zeros;
    mapping(bytes32 root => bool) public isKnownRoot;
    bytes32 public currentRoot;
    uint32 public nextIndex;

    error TreeFull();

    constructor() {
        bytes32 node = bytes32(0);
        for (uint256 level = 0; level < LEVELS; level++) {
            zeros[level] = node;
            filledSubtrees[level] = node;
            node = hashLeftRight(node, node);
        }
        currentRoot = node;
        isKnownRoot[node] = true;
    }

    function hashLeftRight(bytes32 left, bytes32 right) public pure returns (bytes32) {
        return bytes32(PoseidonT3.hash([uint256(left), uint256(right)]));
    }

    function _insert(bytes32 leaf) internal returns (uint32 leafIndex) {
        leafIndex = nextIndex;
        if (leafIndex == uint32(2) ** LEVELS) revert TreeFull();

        uint32 index = leafIndex;
        bytes32 node = leaf;
        for (uint256 level = 0; level < LEVELS; level++) {
            if (index % 2 == 0) {
                filledSubtrees[level] = node;
                node = hashLeftRight(node, zeros[level]);
            } else {
                node = hashLeftRight(filledSubtrees[level], node);
            }
            index /= 2;
        }

        currentRoot = node;
        isKnownRoot[node] = true;
        nextIndex = leafIndex + 1;
    }
}
