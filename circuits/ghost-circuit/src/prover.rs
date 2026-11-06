//! Keygen and proving, shared by the CLI and the WASM prover.

use halo2_base::{
    gates::{
        circuit::{builder::BaseCircuitBuilder, BaseCircuitParams, CircuitBuilderStage},
        flex_gate::MultiPhaseThreadBreakPoints,
    },
    halo2_proofs::{
        halo2curves::bn256::{Bn256, G1Affine},
        plonk::{keygen_pk, keygen_vk, ProvingKey},
        poly::kzg::commitment::ParamsKZG,
    },
};
use serde::{Deserialize, Serialize};
use snark_verifier_sdk::evm::gen_evm_proof_shplonk;

use crate::{
    field::fr_to_hex,
    withdraw::{synthesize, WithdrawWitness},
    Fr, K, LEVELS, MINIMUM_ROWS,
};

/// The circuit's pinned layout. Keygen in the browser has to reproduce the native verifying key
/// exactly (it is baked into the Solidity verifier), so `ghost-cli setup` computes the layout once
/// and the app ships it as JSON.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CircuitConfig {
    pub k: u32,
    pub levels: usize,
    pub params: BaseCircuitParams,
    pub break_points: MultiPhaseThreadBreakPoints,
    /// Hash of the verifying key: a mismatch means the circuit or the KZG parameters changed.
    pub vk_hash: String,
}

pub struct Keys {
    pub pk: ProvingKey<G1Affine>,
    pub config: CircuitConfig,
}

/// Generates the proving key. Without `pinned`, lays the circuit out from scratch (setup); with it,
/// reuses that layout and checks that the verifying key still matches.
pub fn keygen(params: &ParamsKZG<Bn256>, pinned: Option<&CircuitConfig>) -> Result<Keys, String> {
    let builder = BaseCircuitBuilder::<Fr>::from_stage(CircuitBuilderStage::Keygen);
    let mut builder = match pinned {
        Some(config) => builder.use_params(config.params.clone()),
        None => builder.use_k(K as usize).use_instance_columns(1),
    };
    synthesize(&mut builder, &WithdrawWitness::dummy());
    let circuit_params = match pinned {
        Some(config) => config.params.clone(),
        None => builder.calculate_params(Some(MINIMUM_ROWS)),
    };

    let vk = keygen_vk(params, &builder).map_err(|e| format!("keygen_vk: {e:?}"))?;
    let vk_hash = fr_to_hex(&vk.transcript_repr());
    let pk = keygen_pk(params, vk, &builder).map_err(|e| format!("keygen_pk: {e:?}"))?;

    let config = match pinned {
        Some(config) if config.vk_hash != vk_hash => {
            return Err(format!("verifying key mismatch: pinned {}, computed {vk_hash}", config.vk_hash))
        }
        Some(config) => config.clone(),
        None => CircuitConfig {
            k: K,
            levels: LEVELS,
            params: circuit_params,
            break_points: builder.break_points(),
            vk_hash,
        },
    };
    Ok(Keys { pk, config })
}

/// A proof the Solidity verifier accepts (SHPLONK opening, Keccak Fiat-Shamir transcript).
/// Panics if `w` does not satisfy the circuit; callers check the witness first.
pub fn prove(params: &ParamsKZG<Bn256>, keys: &Keys, w: &WithdrawWitness) -> Vec<u8> {
    let mut builder =
        BaseCircuitBuilder::<Fr>::prover(keys.config.params.clone(), keys.config.break_points.clone());
    synthesize(&mut builder, w);
    gen_evm_proof_shplonk(params, &keys.pk, builder, vec![w.public_inputs()])
}
