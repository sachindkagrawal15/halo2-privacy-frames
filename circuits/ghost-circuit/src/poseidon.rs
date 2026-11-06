//! Poseidon with circomlib's parameters for two inputs (t = 3), natively and as a halo2-base gadget.
//!
//! Both follow poseidon-lite's reference loop exactly: the state starts as `[0, a, b]`; every round
//! adds its round constants, applies x^5 to the whole state (full rounds) or to the first element
//! (partial rounds), then multiplies by the MDS matrix; the output is `state[0]`. Matching that loop
//! is what lets the browser (poseidon-lite) and the contract (poseidon-solidity) agree with the circuit.

use std::sync::OnceLock;

use halo2_base::{
    gates::{GateChip, GateInstructions},
    AssignedValue, Context,
    QuantumCell::Constant,
};

use crate::{
    field::parse_fr,
    poseidon_constants::{MDS, ROUND_CONSTANTS},
    Fr,
};

const WIDTH: usize = 3;
const FULL_ROUNDS: usize = 8;
const PARTIAL_ROUNDS: usize = 57;
const ROUNDS: usize = FULL_ROUNDS + PARTIAL_ROUNDS;

struct Constants {
    round: Vec<Fr>,
    mds: [[Fr; WIDTH]; WIDTH],
}

fn constants() -> &'static Constants {
    static CONSTANTS: OnceLock<Constants> = OnceLock::new();
    CONSTANTS.get_or_init(|| Constants {
        round: ROUND_CONSTANTS.iter().map(|c| parse_fr(c).expect("valid constant")).collect(),
        mds: MDS.map(|row| row.map(|c| parse_fr(c).expect("valid constant"))),
    })
}

fn is_full_round(round: usize) -> bool {
    round < FULL_ROUNDS / 2 || round >= FULL_ROUNDS / 2 + PARTIAL_ROUNDS
}

/// Poseidon(a, b), computed natively.
pub fn hash2(a: Fr, b: Fr) -> Fr {
    let Constants { round, mds } = constants();
    let mut state = [Fr::zero(), a, b];
    for r in 0..ROUNDS {
        for (i, s) in state.iter_mut().enumerate() {
            *s += round[r * WIDTH + i];
            if is_full_round(r) || i == 0 {
                let s2 = s.square();
                *s = s2.square() * *s;
            }
        }
        state = std::array::from_fn(|i| (0..WIDTH).fold(Fr::zero(), |acc, j| acc + mds[i][j] * state[j]));
    }
    state[0]
}

/// Poseidon(a, b) as constraints: about 3.7k advice cells.
pub fn hash2_gadget(
    ctx: &mut Context<Fr>,
    gate: &GateChip<Fr>,
    a: AssignedValue<Fr>,
    b: AssignedValue<Fr>,
) -> AssignedValue<Fr> {
    let Constants { round, mds } = constants();
    let mut state = [ctx.load_zero(), a, b];
    for r in 0..ROUNDS {
        for (i, s) in state.iter_mut().enumerate() {
            *s = gate.add(ctx, *s, Constant(round[r * WIDTH + i]));
            if is_full_round(r) || i == 0 {
                let s2 = gate.mul(ctx, *s, *s);
                let s4 = gate.mul(ctx, s2, s2);
                *s = gate.mul(ctx, s4, *s);
            }
        }
        let current = state;
        state = std::array::from_fn(|i| gate.inner_product(ctx, current, mds[i].map(Constant)));
    }
    state[0]
}

#[cfg(test)]
mod tests {
    use super::*;
    use halo2_base::utils::testing::base_test;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Vector {
        a: String,
        b: String,
        out: String,
    }

    fn vectors() -> Vec<Vector> {
        serde_json::from_str(include_str!("poseidon_vectors.json")).unwrap()
    }

    #[test]
    fn native_matches_circomlib_vectors() {
        for v in vectors() {
            let (a, b, out) = (parse_fr(&v.a).unwrap(), parse_fr(&v.b).unwrap(), parse_fr(&v.out).unwrap());
            assert_eq!(hash2(a, b), out, "Poseidon({}, {})", v.a, v.b);
        }
    }

    #[test]
    fn gadget_matches_native() {
        base_test().k(15).run_gate(|ctx, gate| {
            for v in vectors() {
                let (a, b) = (parse_fr(&v.a).unwrap(), parse_fr(&v.b).unwrap());
                let (ca, cb) = (ctx.load_witness(a), ctx.load_witness(b));
                let out = hash2_gadget(ctx, gate, ca, cb);
                assert_eq!(*out.value(), parse_fr(&v.out).unwrap());
            }
        });
    }
}
