//! The withdraw circuit and its witness.

use halo2_base::gates::{circuit::builder::BaseCircuitBuilder, GateChip, GateInstructions};
use serde::Deserialize;

use crate::{
    field::parse_fr,
    merkle::root_from_path,
    poseidon::{hash2, hash2_gadget},
    Fr, LEVELS,
};

/// What the prover knows. Only `recipient`, `fee` and the derived root and nullifier hash are public.
#[derive(Clone, Debug)]
pub struct WithdrawWitness {
    pub nullifier: Fr,
    pub secret: Fr,
    pub leaf_index: u64,
    /// Sibling hashes from the leaf up, `LEVELS` of them.
    pub path: Vec<Fr>,
    pub recipient: Fr,
    pub fee: Fr,
}

/// The JSON shape shared by the CLI, the WASM prover and the web app.
/// Field elements are `0x`-hex (big-endian) or decimal strings.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WitnessJson {
    nullifier: String,
    secret: String,
    leaf_index: u64,
    path_elements: Vec<String>,
    recipient: String,
    fee: String,
}

impl WithdrawWitness {
    pub fn from_json(json: &str) -> Result<Self, String> {
        let w: WitnessJson = serde_json::from_str(json).map_err(|e| format!("witness: {e}"))?;
        if w.path_elements.len() != LEVELS {
            return Err(format!("witness: expected {LEVELS} path elements, got {}", w.path_elements.len()));
        }
        if w.leaf_index >= 1 << LEVELS {
            return Err(format!("witness: leafIndex {} does not fit in the tree", w.leaf_index));
        }
        Ok(Self {
            nullifier: parse_fr(&w.nullifier)?,
            secret: parse_fr(&w.secret)?,
            leaf_index: w.leaf_index,
            path: w.path_elements.iter().map(|p| parse_fr(p)).collect::<Result<_, _>>()?,
            recipient: parse_fr(&w.recipient)?,
            fee: parse_fr(&w.fee)?,
        })
    }

    /// A stand-in witness: keygen only needs the circuit's shape, not real values.
    pub fn dummy() -> Self {
        Self {
            nullifier: Fr::one(),
            secret: Fr::from(2),
            leaf_index: 0,
            path: vec![Fr::zero(); LEVELS],
            recipient: Fr::zero(),
            fee: Fr::zero(),
        }
    }

    pub fn commitment(&self) -> Fr {
        commitment(self.nullifier, self.secret)
    }

    pub fn nullifier_hash(&self) -> Fr {
        nullifier_hash(self.nullifier)
    }

    pub fn root(&self) -> Fr {
        root_from_path(self.commitment(), self.leaf_index, &self.path)
    }

    /// `[root, nullifierHash, recipient, fee]`, in the order the verifier reads them.
    pub fn public_inputs(&self) -> Vec<Fr> {
        vec![self.root(), self.nullifier_hash(), self.recipient, self.fee]
    }
}

/// The leaf a deposit inserts: `Poseidon(nullifier, secret)`.
pub fn commitment(nullifier: Fr, secret: Fr) -> Fr {
    hash2(nullifier, secret)
}

/// What a withdrawal reveals to block double spends: `Poseidon(nullifier, 1)`. The constant second
/// input keeps it unlinkable to the commitment, which hashes the random secret instead.
pub fn nullifier_hash(nullifier: Fr) -> Fr {
    hash2(nullifier, Fr::one())
}

/// Lays out the withdraw constraints in `builder` and exposes the four public inputs.
pub fn synthesize(builder: &mut BaseCircuitBuilder<Fr>, w: &WithdrawWitness) {
    let gate = GateChip::<Fr>::default();
    let ctx = builder.main(0);

    let nullifier = ctx.load_witness(w.nullifier);
    let secret = ctx.load_witness(w.secret);
    let recipient = ctx.load_witness(w.recipient);
    let fee = ctx.load_witness(w.fee);
    let one = ctx.load_constant(Fr::one());

    let commitment = hash2_gadget(ctx, &gate, nullifier, secret);
    let nullifier_hash = hash2_gadget(ctx, &gate, nullifier, one);

    // Bit i set means the node at level i is a right child. num_to_bits also proves index < 2^LEVELS.
    let index = ctx.load_witness(Fr::from(w.leaf_index));
    let bits = gate.num_to_bits(ctx, index, LEVELS);
    let mut node = commitment;
    for (level, bit) in bits.into_iter().enumerate() {
        let sibling = ctx.load_witness(w.path[level]);
        let left = gate.select(ctx, sibling, node, bit);
        let right = gate.select(ctx, node, sibling, bit);
        node = hash2_gadget(ctx, &gate, left, right);
    }

    // recipient and fee take part in no other constraint: exposing them is what binds them to the proof.
    builder.assigned_instances[0].extend([node, nullifier_hash, recipient, fee]);
}
