//! The in-browser prover. Call `init` once with the KZG parameters and the pinned circuit
//! config (keygen runs in the browser and takes about as long as one proof), then `prove` per
//! withdrawal. The note never leaves the page.

use std::cell::RefCell;

use ghost_circuit::{
    field::{fr_to_hex, parse_fr},
    halo2_base::halo2_proofs::{
        halo2curves::bn256::Bn256,
        poly::{commitment::Params, kzg::commitment::ParamsKZG},
    },
    poseidon::hash2,
    prover::{keygen, prove as prove_withdrawal, CircuitConfig, Keys},
    withdraw::WithdrawWitness,
    K,
};
use wasm_bindgen::prelude::*;

struct Prover {
    params: ParamsKZG<Bn256>,
    keys: Keys,
}

thread_local! {
    static PROVER: RefCell<Option<Prover>> = const { RefCell::new(None) };
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// Loads the KZG parameters and generates the proving key. Returns the verifying key hash, which
/// must equal `config.vkHash`.
#[wasm_bindgen]
pub fn init(params_bytes: &[u8], config_json: &str) -> Result<String, JsError> {
    let mut params = ParamsKZG::<Bn256>::read(&mut &params_bytes[..]).map_err(|e| js_err(format!("params: {e}")))?;
    if params.k() < K {
        return Err(js_err(format!("params are for k = {}, the circuit needs {K}", params.k())));
    }
    // downsize recomputes the Lagrange basis (a group FFT, minutes on one WASM thread): only when needed.
    if params.k() > K {
        params.downsize(K);
    }
    let config: CircuitConfig = serde_json::from_str(config_json).map_err(|e| js_err(format!("config: {e}")))?;
    let keys = keygen(&params, Some(&config)).map_err(js_err)?;
    let vk_hash = keys.config.vk_hash.clone();
    PROVER.with(|p| *p.borrow_mut() = Some(Prover { params, keys }));
    Ok(vk_hash)
}

/// Proves a withdrawal. Takes the witness JSON (see `WithdrawWitness`) and returns
/// `{ "proof": "0x…", "publicInputs": ["0x…", …] }`.
#[wasm_bindgen]
pub fn prove(witness_json: &str) -> Result<String, JsError> {
    let witness = WithdrawWitness::from_json(witness_json).map_err(js_err)?;
    PROVER.with(|p| {
        let p = p.borrow();
        let p = p.as_ref().ok_or_else(|| js_err("call init() before prove()"))?;
        let proof = prove_withdrawal(&p.params, &p.keys, &witness);
        Ok(serde_json::json!({
            "proof": format!("0x{}", hex::encode(proof)),
            "publicInputs": witness.public_inputs().iter().map(fr_to_hex).collect::<Vec<_>>(),
        })
        .to_string())
    })
}

/// Times each keygen phase, to find where the browser spends its time.
#[wasm_bindgen]
pub fn bench_keygen(params_bytes: &[u8], config_json: &str) -> Result<String, JsError> {
    use ghost_circuit::{
        halo2_base::{
            gates::circuit::{builder::BaseCircuitBuilder, CircuitBuilderStage},
            halo2_proofs::plonk::{keygen_pk, keygen_vk},
        },
        withdraw::synthesize,
    };
    let now = js_sys::Date::now;
    let t0 = now();
    let params = ParamsKZG::<Bn256>::read(&mut &params_bytes[..]).map_err(js_err)?;
    let t1 = now();
    let config: CircuitConfig = serde_json::from_str(config_json).map_err(js_err)?;
    let mut builder = BaseCircuitBuilder::from_stage(CircuitBuilderStage::Keygen).use_params(config.params.clone());
    synthesize(&mut builder, &WithdrawWitness::dummy());
    let t2 = now();
    let vk = keygen_vk(&params, &builder).map_err(|e| js_err(format!("{e:?}")))?;
    let t3 = now();
    let _pk = keygen_pk(&params, vk, &builder).map_err(|e| js_err(format!("{e:?}")))?;
    let t4 = now();
    Ok(format!(
        "read params {:.0} ms, synthesize {:.0} ms, keygen_vk {:.0} ms, keygen_pk {:.0} ms",
        t1 - t0,
        t2 - t1,
        t3 - t2,
        t4 - t3
    ))
}

/// Poseidon(a, b) with the circuit's own implementation, for cross-checking poseidon-lite.
#[wasm_bindgen]
pub fn poseidon2(a: &str, b: &str) -> Result<String, JsError> {
    Ok(fr_to_hex(&hash2(parse_fr(a).map_err(js_err)?, parse_fr(b).map_err(js_err)?)))
}
