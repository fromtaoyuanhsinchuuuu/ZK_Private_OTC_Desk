// Hardcoded display-only addresses for demo UI fallback.
// Prefer setting NEXT_PUBLIC_ETHM / NEXT_PUBLIC_USDC or relying on /config from the offchain server.
export const DEFAULT_ETHM_ADDR = (process.env.NEXT_PUBLIC_ETHM as string) || '0x1000000000000000000000000000000000000001';
export const DEFAULT_USDC_ADDR = (process.env.NEXT_PUBLIC_USDC as string) || '0x1000000000000000000000000000000000000002';
