use dep ::common::demo_hash2;

fn main(
    kyc_ts: u64,        // private: KYC timestamp
    salt: Field,        // private
    commitment: Field,  // public
    now_ts: u64,        // public
    max_age_secs: u64   // public (e.g., 365d)
) {
    let com = demo_hash2(kyc_ts as Field, salt);
    assert(com == commitment);
    assert(now_ts >= kyc_ts);
    let age = now_ts - kyc_ts;
    assert(age <= max_age_secs);
}
