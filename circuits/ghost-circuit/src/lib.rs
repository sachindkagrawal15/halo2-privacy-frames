//! The withdraw circuit, written with halo2-base and proven with Halo2 (KZG on BN254).
//!
//! A withdrawal proves: "I know `nullifier` and `secret` such that `Poseidon(nullifier, secret)` is a
//! leaf of the deposit tree with root `root`, and `nullifierHash = Poseidon(nullifier, 1)`", while
//! binding the payout `recipient` and `fee` into the proof. Public inputs, in this order:
//! `[root, nullifierHash, recipient, fee]`.

pub mod field;
pub mod merkle;
pub mod poseidon;
mod poseidon_constants;
pub mod prover;
pub mod withdraw;

pub use halo2_base;
pub use halo2_base::halo2_proofs::halo2curves::bn256::Fr;

/// Depth of the deposit tree: 2^20, about a million deposits.
pub const LEVELS: usize = 20;
/// The circuit has 2^K rows.
pub const K: u32 = 15;
/// Rows kept free of witness cells for the blinding factors that make the proof zero-knowledge.
pub const MINIMUM_ROWS: usize = 20;
/// `[root, nullifierHash, recipient, fee]`.
pub const NUM_PUBLIC_INPUTS: usize = 4;
