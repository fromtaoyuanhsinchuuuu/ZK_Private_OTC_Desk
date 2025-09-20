import { createPublicClient, http, parseAbi } from 'viem';

const REG_ABI = parseAbi(['function isValid(bytes32,bytes32) view returns (bool)']);

function getClient() {
  const rpc = process.env.NEXT_PUBLIC_RPC_URL;
  if (!rpc) return null as any;
  return createPublicClient({ transport: http(rpc) });
}

export async function checkAtts(orderHash: `0x${string}`, atts: Record<string, `0x${string}`>) {
  const client = getClient();
  const addr = process.env.NEXT_PUBLIC_REGISTRY as `0x${string}` | undefined;
  if (!client || !addr) return null;
  const entries = Object.entries(atts || {});
  const results = await Promise.all(entries.map(async ([k, att]) => {
    const ok = await client.readContract({ address: addr, abi: REG_ABI, functionName: 'isValid', args: [att, orderHash] });
    return [k, !!ok] as const;
  }));
  return Object.fromEntries(results) as Record<string, boolean>;
}
