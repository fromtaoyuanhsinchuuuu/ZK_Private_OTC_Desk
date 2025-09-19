use dep ::common::merkle_verify;

fn main(
    merkle_root: Field, // public
    leaf: Field,        // private (hashed addr)
    path: [Field; 16],  // private
    dirs: [bool; 16]    // private
) {
    assert(merkle_verify(merkle_root, leaf, path, dirs));
}
