//! One-time setup (keygen and the Solidity verifier) and native proving for the withdraw circuit.

use std::{fs, io::BufReader, path::Path, time::Instant};

use ghost_circuit::{
    field::{fr_to_hex, parse_fr},
    halo2_base::{
        gates::circuit::builder::BaseCircuitBuilder,
        halo2_proofs::{
            halo2curves::{bn256::Bn256, ff::PrimeField},
            poly::{commitment::Params, kzg::commitment::ParamsKZG},
        },
    },
    merkle::MerkleTree,
    poseidon::hash2,
    prover::{keygen, prove, CircuitConfig},
    withdraw::{commitment, WithdrawWitness},
    Fr, K, LEVELS, NUM_PUBLIC_INPUTS,
};
use rand::RngCore;
use serde_json::json;
use snark_verifier_sdk::{
    evm::{encode_calldata, evm_verify, gen_evm_verifier_sol_code},
    SHPLONK,
};

const USAGE: &str = "usage:
  ghost-cli setup <params.srs> <out-dir>                  keygen; write config.json, GhostVerifier.sol, sample.json
  ghost-cli prove <params.srs> <config.json> <witness.json>  print {proof, publicInputs, calldata} as JSON
  ghost-cli gas <verifier-bytecode.hex> <sample.json>     run the verifier in revm and print its gas
  ghost-cli hash <a> <b>                                  Poseidon(a, b)";

fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["setup", srs, out] => setup(srs, Path::new(out)),
        ["prove", srs, config, witness] => prove_cmd(srs, config, witness),
        ["gas", bytecode, sample] => gas(bytecode, sample),
        ["hash", a, b] => {
            println!("{}", fr_to_hex(&hash2(parse_fr(a)?, parse_fr(b)?)));
            Ok(())
        }
        _ => Err(USAGE.into()),
    }
}

fn read_params(path: &str) -> Result<ParamsKZG<Bn256>, String> {
    let file = fs::File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let mut params = ParamsKZG::<Bn256>::read(&mut BufReader::new(file)).map_err(|e| format!("{path}: {e}"))?;
    if params.k() < K {
        return Err(format!("{path}: parameters for k = {}, the circuit needs {K}", params.k()));
    }
    // downsize recomputes the Lagrange basis (a group FFT): only when the file is for a larger k.
    if params.k() > K {
        params.downsize(K);
    }
    Ok(params)
}

fn write(path: &Path, contents: &str) -> Result<(), String> {
    fs::write(path, contents).map_err(|e| format!("{}: {e}", path.display()))
}

/// 31 random bytes: always a valid field element.
fn random_fr(rng: &mut impl RngCore) -> Fr {
    let mut bytes = [0u8; 32];
    rng.fill_bytes(&mut bytes[..31]);
    Fr::from_repr(bytes).unwrap()
}

fn setup(srs: &str, out: &Path) -> Result<(), String> {
    let params = read_params(srs)?;
    fs::create_dir_all(out).map_err(|e| format!("{}: {e}", out.display()))?;

    let started = Instant::now();
    let keys = keygen(&params, None)?;
    eprintln!("keygen {:.1?}: {:?}", started.elapsed(), keys.config.params);
    let config = serde_json::to_string_pretty(&keys.config).unwrap();
    write(&out.join("config.json"), &config)?;

    let solidity = gen_evm_verifier_sol_code::<BaseCircuitBuilder<Fr>, SHPLONK>(
        &params,
        keys.pk.get_vk(),
        vec![NUM_PUBLIC_INPUTS],
    );
    write(&out.join("GhostVerifier.sol"), &solidity)?;

    // A sample withdrawal of the middle deposit out of three, for gas measurement and contract tests.
    let mut rng = rand::thread_rng();
    let (nullifier, secret) = (random_fr(&mut rng), random_fr(&mut rng));
    let tree = MerkleTree::new(LEVELS, vec![random_fr(&mut rng), commitment(nullifier, secret), random_fr(&mut rng)]);
    let witness = WithdrawWitness {
        nullifier,
        secret,
        leaf_index: 1,
        path: tree.path(1),
        recipient: parse_fr("0x8943545177806ED17B9F23F0a21ee5948eCaa776")?,
        fee: Fr::from(1_000_000_000_000_000u64),
    };
    assert_eq!(witness.root(), tree.root());

    let started = Instant::now();
    let proof = prove(&params, &keys, &witness);
    eprintln!("prove {:.1?}: {} bytes", started.elapsed(), proof.len());
    let public_inputs = witness.public_inputs();
    let sample = json!({
        "publicInputs": public_inputs.iter().map(fr_to_hex).collect::<Vec<_>>(),
        "proof": format!("0x{}", hex::encode(&proof)),
        "calldata": format!("0x{}", hex::encode(encode_calldata(&[public_inputs], &proof))),
    });
    write(&out.join("sample.json"), &serde_json::to_string_pretty(&sample).unwrap())?;
    eprintln!("wrote config.json, GhostVerifier.sol and sample.json to {}", out.display());
    Ok(())
}

fn prove_cmd(srs: &str, config: &str, witness: &str) -> Result<(), String> {
    let params = read_params(srs)?;
    let config: CircuitConfig = serde_json::from_str(&fs::read_to_string(config).map_err(|e| format!("{config}: {e}"))?)
        .map_err(|e| format!("{config}: {e}"))?;
    let witness = WithdrawWitness::from_json(&fs::read_to_string(witness).map_err(|e| format!("{witness}: {e}"))?)?;
    let keys = keygen(&params, Some(&config))?;
    let proof = prove(&params, &keys, &witness);
    let public_inputs = witness.public_inputs();
    println!(
        "{}",
        json!({
            "publicInputs": public_inputs.iter().map(fr_to_hex).collect::<Vec<_>>(),
            "proof": format!("0x{}", hex::encode(&proof)),
            "calldata": format!("0x{}", hex::encode(encode_calldata(&[public_inputs], &proof))),
        })
    );
    Ok(())
}

fn gas(bytecode: &str, sample: &str) -> Result<(), String> {
    let bytecode = fs::read_to_string(bytecode).map_err(|e| format!("{bytecode}: {e}"))?;
    let bytecode = hex::decode(bytecode.trim().trim_start_matches("0x")).map_err(|e| e.to_string())?;
    let sample: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(sample).map_err(|e| format!("{sample}: {e}"))?).map_err(|e| e.to_string())?;
    let public_inputs = sample["publicInputs"]
        .as_array()
        .ok_or("sample.json: no publicInputs")?
        .iter()
        .map(|x| parse_fr(x.as_str().unwrap_or_default()))
        .collect::<Result<Vec<_>, _>>()?;
    let proof = hex::decode(sample["proof"].as_str().unwrap_or_default().trim_start_matches("0x")).map_err(|e| e.to_string())?;
    let gas = evm_verify(bytecode, vec![public_inputs], proof)?;
    println!("{gas}");
    Ok(())
}
