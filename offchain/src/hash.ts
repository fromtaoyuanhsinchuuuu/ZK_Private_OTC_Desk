import { Hex, keccak256, stringToBytes, encodeAbiParameters } from "viem";

export function orderHash(o: {maker:string;base:string;quote:string;size:bigint;minPrice:bigint;expiry:number}){
  const s = `${o.maker}|${o.base}|${o.quote}|${o.size}|${o.minPrice}|${o.expiry}`;
  return keccak256(stringToBytes(s));
}

export function attestationIdFrom(obj: any){
  return keccak256(stringToBytes(JSON.stringify(obj)));
}

export const QUOTE_TYPEHASH: Hex = keccak256(
  stringToBytes("QuoteCommitment(bytes32 orderHash,address maker,uint256 quoteAmount,uint64 validUntil,uint256 nonce)")
);

export type QuoteHashInput = {
  orderHash: Hex;
  maker: Hex;
  quoteAmount: bigint;
  validUntil: bigint;
  nonce: bigint;
};

export function quoteStructHash(input: QuoteHashInput): Hex {
  const encoded = encodeAbiParameters(
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
      input.orderHash,
      input.maker,
      input.quoteAmount,
      input.validUntil,
      input.nonce
    ]
  );
  return keccak256(encoded);
}
