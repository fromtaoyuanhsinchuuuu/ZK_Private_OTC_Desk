import { createWalletClient, http, parseAbi, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const REG_ABI = parseAbi(["function record(bytes32,bytes32)","function isValid(bytes32,bytes32) view returns (bool)"]);
const SETTLE_ABI = parseAbi(["function settleRFQ(bytes32,bytes32,bytes32,bytes32,bytes32,address,address,address,address,uint256,uint256)"]);

export function getClients(){
  const rpc = process.env.RPC_URL!;
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as Hex);
  const chainId = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : undefined;
  const client = createWalletClient({ account, transport: http(rpc), chain: chainId ? { id: chainId, name: `custom-${chainId}` } as any : undefined });
  const registry = { address: process.env.REGISTRY_ADDR as Hex, abi: REG_ABI } as const;
  const settle = { address: process.env.SETTLEMENT_ADDR as Hex, abi: SETTLE_ABI } as const;
  return { client, registry, settle };
}

export async function recordAttest(attId: Hex, orderHash: Hex){
  const { client, registry } = getClients();
  return client.writeContract({ ...registry, functionName: 'record', args: [attId, orderHash] });
}

export async function settle(args:{orderHash:Hex, atts:Record<string,Hex>, maker:Hex, taker:Hex, base:Hex, quote:Hex, size:bigint, price:bigint}){
  const { client, settle } = getClients();
  const {orderHash,atts,maker,taker,base,quote,size,price} = args;
  return client.writeContract({ ...settle, functionName:'settleRFQ', args:[orderHash, atts['solvency'], atts['kyc'], atts['whitelist'], (atts['bestexec']||'0x0000000000000000000000000000000000000000000000000000000000000000') as Hex, maker, taker, base, quote, size, price] });
}
