//! The deposit tree: a fixed-depth binary Merkle tree hashed with Poseidon and filled left to right.
//! A missing node takes the value of an empty subtree, `zeros[level]`, with `zeros[0] = 0`, which is
//! exactly what the incremental tree in `GhostPool.sol` computes.

use crate::{poseidon::hash2, Fr};

/// `zeros[i]` is the root of an empty subtree of height `i`; the result has `levels + 1` entries.
pub fn zeros(levels: usize) -> Vec<Fr> {
    let mut zeros = vec![Fr::zero()];
    for i in 0..levels {
        zeros.push(hash2(zeros[i], zeros[i]));
    }
    zeros
}

pub struct MerkleTree {
    levels: usize,
    layers: Vec<Vec<Fr>>,
    zeros: Vec<Fr>,
}

impl MerkleTree {
    pub fn new(levels: usize, leaves: Vec<Fr>) -> Self {
        assert!(leaves.len() <= 1 << levels, "more leaves than the tree holds");
        let zeros = zeros(levels);
        let mut layers = vec![leaves];
        for level in 0..levels {
            let above = layers[level]
                .chunks(2)
                .map(|pair| hash2(pair[0], *pair.get(1).unwrap_or(&zeros[level])))
                .collect();
            layers.push(above);
        }
        Self { levels, layers, zeros }
    }

    pub fn root(&self) -> Fr {
        self.layers[self.levels].first().copied().unwrap_or(self.zeros[self.levels])
    }

    /// The sibling of every node on the way from leaf `index` to the root, bottom first.
    pub fn path(&self, index: usize) -> Vec<Fr> {
        assert!(index < self.layers[0].len(), "no leaf at index {index}");
        let mut node = index;
        (0..self.levels)
            .map(|level| {
                let sibling = self.layers[level].get(node ^ 1).copied().unwrap_or(self.zeros[level]);
                node >>= 1;
                sibling
            })
            .collect()
    }
}

/// The root reached from `leaf` at `index` through `path`. Bit `i` of `index` set means the node at
/// level `i` is a right child.
pub fn root_from_path(leaf: Fr, index: u64, path: &[Fr]) -> Fr {
    path.iter().enumerate().fold(leaf, |node, (level, sibling)| {
        if (index >> level) & 1 == 1 {
            hash2(*sibling, node)
        } else {
            hash2(node, *sibling)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_lead_to_the_root() {
        let leaves: Vec<Fr> = (1..=5u64).map(Fr::from).collect();
        let tree = MerkleTree::new(4, leaves.clone());
        for (i, leaf) in leaves.iter().enumerate() {
            assert_eq!(root_from_path(*leaf, i as u64, &tree.path(i)), tree.root());
        }
    }

    #[test]
    fn empty_tree_root_is_the_empty_subtree() {
        assert_eq!(MerkleTree::new(3, vec![]).root(), zeros(3)[3]);
    }
}
