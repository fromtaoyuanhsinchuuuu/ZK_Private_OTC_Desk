import { keccak256, stringToBytes } from "viem";
export function orderHash(o: {maker:string;base:string;quote:string;size:bigint;minPrice:bigint;expiry:number}){
  const s = `${o.maker}|${o.base}|${o.quote}|${o.size}|${o.minPrice}|${o.expiry}`;
  return keccak256(stringToBytes(s));
}
export function attestationIdFrom(obj: any){ return keccak256(stringToBytes(JSON.stringify(obj))); }
