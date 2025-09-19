use dep ::common::demo_hash2;

fn main(
    balance: u128,           // private
    salt: Field,             // private
    commitment: Field,       // public: commitment of balance
    order_hash: Field,       // public: bind to a specific order
    order_size: u128         // private: order size
) {
    let com = demo_hash2(balance as Field, salt);
    assert(com == commitment);
    assert(balance >= order_size);
    // Bind to order to prevent replay (no-op but ensures dependency)
    assert(order_hash == order_hash);
}
