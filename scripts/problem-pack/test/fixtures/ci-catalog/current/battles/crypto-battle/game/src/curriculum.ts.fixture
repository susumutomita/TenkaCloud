import { deriveBigInt } from "./prng.ts";
import type { ContractPlan } from "./fixtures.ts";
/** One of each topic per shuffled bag of non-duel orders. */
const TOPICS = ["caesar", "vigenere", "rotor-encrypt", "enigma-encrypt", "rsa-encrypt", "rsa-decrypt", "ecdsa-sign", "zk-sudoku", "homomorphic-sum", "masked-total", "reveal-share", "ec-add", "snark-constraints", "stark-trace", "io-equivalence", "anamorphic-rejection"] as const;
export function curriculumPlan(seed: string, index: number, base: ContractPlan, shareCount = 5): ContractPlan {
  if (index < 2) return base;
  const offset=index-2, cycle=Math.floor(offset/TOPICS.length);
  const bag=[...TOPICS];
  for(let i=bag.length-1;i>0;i--) {
    const j=Number(deriveBigInt(seed,`curriculum:${cycle}`,i,BigInt(i+1)));
    [bag[i],bag[j]]=[bag[j]!,bag[i]!];
  }
  const topic=bag[offset%bag.length]!;
  if(topic==="caesar" || topic==="vigenere")return {...base,taskKind:"caesar-shift",rung:topic,keyPosition:topic==="vigenere"?cycle%3:undefined,privacyConstraint:"none",requestedShareIndices:[]};
  return {...base,rung:undefined,taskKind:topic,privacyConstraint:topic==="reveal-share"?"must-disclose":topic==="rotor-encrypt"||topic==="rsa-encrypt"?"none":"no-raw-disclosure",requestedShareIndices:topic==="reveal-share"?[cycle%shareCount+1]:[]};
}
