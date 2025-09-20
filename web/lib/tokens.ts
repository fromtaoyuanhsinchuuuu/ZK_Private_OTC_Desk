const mapFromEnv = () => {
  const m: Record<string,string> = {};
  const entries: Array<[string | undefined, string]> = [
    [process.env.NEXT_PUBLIC_USDC_ADDR, 'USDC'],
    [process.env.NEXT_PUBLIC_ETHM_ADDR, 'ETHm'],
  ];
  for (const [addr, sym] of entries) {
    if (addr && /^0x[0-9a-fA-F]{40}$/.test(addr)) m[addr.toLowerCase()] = sym!;
  }
  return m;
};

const TOKENS = mapFromEnv();

export function labelPair(base?: string, quote?: string) {
  const b = (base||'').toLowerCase();
  const q = (quote||'').toLowerCase();
  const bs = TOKENS[b] || base || '?';
  const qs = TOKENS[q] || quote || '?';
  return `${bs}/${qs}`;
}
