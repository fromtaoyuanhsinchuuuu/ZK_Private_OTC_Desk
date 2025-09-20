import { createPublicClient, http, parseAbi } from 'viem';

const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
]);

const client = (() => {
  const rpc = process.env.NEXT_PUBLIC_RPC_URL;
  if (!rpc) return null as any;
  try { return createPublicClient({ transport: http(rpc) }); } catch { return null as any; }
})();

const cache = new Map<string, { symbol: string; decimals: number }>();

export async function getTokenMeta(addr?: string) {
  if (!addr || typeof addr !== 'string' || !addr.startsWith('0x') || addr.length !== 42) {
    return { symbol: '??', decimals: 18 };
  }
  const key = addr.toLowerCase();
  if (cache.has(key)) return cache.get(key)!;
  if (!client) {
    const meta = { symbol: short(addr), decimals: 18 };
    cache.set(key, meta);
    return meta;
  }
  try {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: addr as `0x${string}`, abi: erc20Abi, functionName: 'symbol' }) as Promise<string>,
      client.readContract({ address: addr as `0x${string}`, abi: erc20Abi, functionName: 'decimals' }) as Promise<number>
    ]);
    const meta = { symbol, decimals };
    cache.set(key, meta);
    return meta;
  } catch {
    const fallback = { symbol: short(addr), decimals: 18 };
    cache.set(key, fallback);
    return fallback;
  }
}

export function short(addr?: string) {
  return addr ? `${addr.slice(0,6)}…${addr.slice(-4)}` : '??';
}
