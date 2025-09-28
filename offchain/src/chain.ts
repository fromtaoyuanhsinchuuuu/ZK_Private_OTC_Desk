import { Hex, createPublicClient, createWalletClient, encodeAbiParameters, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { quoteStructHash, QuoteHashInput, QUOTE_TYPEHASH } from "./hash";

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

const REG_ABI = parseAbi([
  "function record(bytes32,bytes32,uint8)",
  "function isValid(bytes32,bytes32) view returns (bool)",
  "function attMaskByOrder(bytes32) view returns (uint8)",
  "function attestationOK(bytes32) view returns (bool)"
]);

const SETTLE_ABI = parseAbi([
  "function createRFQ(bytes32 orderHash,uint64 expiry)",
  "function cancelRFQ(bytes32 orderHash)",
  "function isOpen(bytes32 orderHash) view returns (bool)",
  "function rfqs(bytes32 orderHash) view returns (address maker,uint64 expiry)",
  "function usedOrder(bytes32 orderHash) view returns (bool)",
  "function usedQuote(bytes32 quoteHash) view returns (bool)",
  "function domainSeparator() view returns (bytes32)",
  "function quoteStructHash((bytes32 orderHash,address maker,uint256 quoteAmount,uint64 validUntil,uint256 nonce)) view returns (bytes32)",
  "function settleRFQ((bytes32 orderHash,address maker,uint256 quoteAmount,uint64 validUntil,uint256 nonce) quote_,uint8 v,bytes32 r,bytes32 s,bytes32 solvencyAtt,bytes32 kycAtt,bytes32 whitelistAtt,bytes32 bestExecAtt,address taker,address baseToken,address quoteToken,uint256 size,uint256 price)"
]);

export type QuoteCommitment = QuoteHashInput;

type Clients = {
  wallet: ReturnType<typeof createWalletClient>;
  reader: ReturnType<typeof createPublicClient>;
  registry: { address: Hex; abi: typeof REG_ABI };
  settlement: { address: Hex; abi: typeof SETTLE_ABI };
  account: ReturnType<typeof privateKeyToAccount>;
};

export function getClients(): Clients {
  const rpc = process.env.RPC_URL!;
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as Hex);
  const wallet = createWalletClient({ account, transport: http(rpc) });
  const reader = createPublicClient({ transport: http(rpc) });
  const registry = { address: process.env.REGISTRY_ADDR as Hex, abi: REG_ABI } as const;
  const settlement = { address: process.env.SETTLEMENT_ADDR as Hex, abi: SETTLE_ABI } as const;
  return { wallet, reader, registry, settlement, account };
}

export async function recordAttest(attId: Hex, orderHash: Hex, attType: number){
  const { wallet, registry, account } = getClients();
  return wallet.writeContract({
    account,
    ...registry,
    functionName: "record",
    args: [attId, orderHash, attType],
    chain: undefined
  });
}

export async function createRFQOnchain(orderHash: Hex, expiry: number | bigint){
  const { wallet, settlement, account } = getClients();
  const expiry64 = typeof expiry === "bigint" ? expiry : BigInt(expiry);
  return wallet.writeContract({
    account,
    ...settlement,
    functionName: "createRFQ",
    args: [orderHash, expiry64],
    chain: undefined
  });
}

export async function cancelRFQOnchain(orderHash: Hex){
  const { wallet, settlement, account } = getClients();
  return wallet.writeContract({
    account,
    ...settlement,
    functionName: "cancelRFQ",
    args: [orderHash],
    chain: undefined
  });
}

export type SettleArgs = {
  commitment: QuoteCommitment;
  signature: Hex;
  atts: Record<string, Hex>;
  taker: Hex;
  base: Hex;
  quoteToken: Hex;
  size: bigint;
  price: bigint;
};

export async function settle(args: SettleArgs){
  const { wallet, settlement, account } = getClients();
  const { commitment, signature, atts, taker, base, quoteToken, size, price } = args;
  const { v, r, s } = splitSignature(signature);
  const bestExec = (atts["bestexec"] || ZERO_BYTES32) as Hex;

  const q: QuoteCommitment = {
    orderHash: commitment.orderHash,
    maker: commitment.maker,
    quoteAmount: commitment.quoteAmount,
    validUntil: typeof commitment.validUntil === "bigint" ? commitment.validUntil : BigInt(commitment.validUntil),
    nonce: typeof commitment.nonce === "bigint" ? commitment.nonce : BigInt(commitment.nonce)
  };

  return wallet.writeContract({
    account,
    ...settlement,
    functionName: "settleRFQ",
    args: [
      q,
      v,
      r,
      s,
      atts["solvency"] as Hex,
      atts["kyc"] as Hex,
      atts["whitelist"] as Hex,
      bestExec,
      taker,
      base,
      quoteToken,
      size,
      price
    ],
    chain: undefined
  });
}

export async function fetchPreflight(orderHash: Hex, q: QuoteCommitment){
  const { reader, registry, settlement } = getClients();
  const normalized: QuoteCommitment = {
    orderHash: q.orderHash,
    maker: q.maker,
    quoteAmount: q.quoteAmount,
    validUntil: typeof q.validUntil === "bigint" ? q.validUntil : BigInt(q.validUntil),
    nonce: typeof q.nonce === "bigint" ? q.nonce : BigInt(q.nonce)
  };
  const quoteHash = quoteStructHash(normalized);
  const maskRaw = await reader.readContract({ ...registry, functionName: "attMaskByOrder", args: [orderHash] }) as number;
  const isOpen = await reader.readContract({ ...settlement, functionName: "isOpen", args: [orderHash] }) as boolean;
  const usedOrder = await reader.readContract({ ...settlement, functionName: "usedOrder", args: [orderHash] }) as boolean;
  const usedQuote = await reader.readContract({ ...settlement, functionName: "usedQuote", args: [quoteHash] }) as boolean;

  const attestationOk = await reader.readContract({
    ...registry,
    functionName: "attestationOK",
    args: [orderHash]
  }) as boolean;

  return {
  mask: Number(maskRaw),
    attestationOk,
    isOpen,
    usedOrder,
    usedQuote,
    quoteHash
  };
}

export async function getDomainSeparator(){
  const { reader, settlement } = getClients();
  return reader.readContract({ ...settlement, functionName: "domainSeparator", args: [] }) as Promise<Hex>;
}

export function encodeQuote(commitment: QuoteCommitment): Hex {
  const validUntil = typeof commitment.validUntil === "bigint" ? commitment.validUntil : BigInt(commitment.validUntil);
  const nonce = typeof commitment.nonce === "bigint" ? commitment.nonce : BigInt(commitment.nonce);

  return encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "address" },
      { type: "uint256" },
      { type: "uint64" },
      { type: "uint256" }
    ],
    [
      QUOTE_TYPEHASH,
      commitment.orderHash,
      commitment.maker,
      commitment.quoteAmount,
      validUntil,
      nonce
    ]
  );
}

function splitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  if (!signature || signature.length !== 132) {
    throw new Error("Invalid signature length");
  }
  const r = (`0x${signature.slice(2, 66)}`) as Hex;
  const s = (`0x${signature.slice(66, 130)}`) as Hex;
  let v = Number.parseInt(signature.slice(130, 132), 16);
  if (v < 27) v += 27;
  return { v, r, s };
}

