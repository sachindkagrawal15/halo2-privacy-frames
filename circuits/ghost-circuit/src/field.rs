//! Conversions between BN254 scalars and the strings used in JSON, Solidity and JavaScript.
//! Hex strings are big-endian, like `uint256` and `bytes32` on chain.

use halo2_base::halo2_proofs::halo2curves::ff::PrimeField;

use crate::Fr;

/// Parses `0x`-prefixed big-endian hex (up to 32 bytes) or a decimal string.
pub fn parse_fr(s: &str) -> Result<Fr, String> {
    let s = s.trim();
    match s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        Some(hex_digits) => {
            if hex_digits.len() > 64 {
                return Err(format!("{s}: more than 32 bytes"));
            }
            let padded = format!("{hex_digits:0>64}");
            let mut bytes: [u8; 32] = hex::decode(padded)
                .map_err(|e| format!("{s}: {e}"))?
                .try_into()
                .expect("64 hex digits are 32 bytes");
            bytes.reverse();
            Option::from(Fr::from_repr(bytes)).ok_or_else(|| format!("{s}: not below the BN254 scalar field modulus"))
        }
        None => Fr::from_str_vartime(s).ok_or_else(|| format!("{s}: not a decimal field element")),
    }
}

/// `0x`-prefixed, 64-digit big-endian hex.
pub fn fr_to_hex(x: &Fr) -> String {
    let mut bytes = x.to_repr();
    bytes.reverse();
    format!("0x{}", hex::encode(bytes))
}

/// Big-endian 32-byte word, as the EVM verifier reads public inputs.
pub fn fr_to_be_bytes(x: &Fr) -> [u8; 32] {
    let mut bytes = x.to_repr();
    bytes.reverse();
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_and_decimal_round_trip() {
        let x = parse_fr("0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a").unwrap();
        assert_eq!(
            x,
            parse_fr("7853200120776062878684798364095072458815029376092732009249414926327459813530").unwrap()
        );
        assert_eq!(fr_to_hex(&x), "0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a");
        assert_eq!(parse_fr("0x1").unwrap(), Fr::from(1));
    }

    #[test]
    fn rejects_values_above_the_modulus() {
        assert!(parse_fr("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff").is_err());
    }
}
