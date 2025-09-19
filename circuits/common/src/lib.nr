// Demo hash (INSECURE): only for MVP use
pub fn demo_hash2(a: Field, b: Field) -> Field { a * 3 + b * 5 }

global PATH_LEN: u32 = 16;

// Simplified Merkle verify using demo_hash2 (INSECURE)
pub fn merkle_verify(root: Field, leaf: Field, path: [Field; PATH_LEN], dirs: [bool; PATH_LEN]) -> bool {
    let mut cur = leaf;
    for i in 0..PATH_LEN {
        let sib = path[i];
        let left  = if dirs[i] == false { cur } else { sib };
        let right = if dirs[i] == false { sib } else { cur };
        cur = demo_hash2(left, right);
    }
    cur == root
}
