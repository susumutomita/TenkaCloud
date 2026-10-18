export type EvolutionTask =
  | { readonly kind: "rsa-decrypt"; readonly ciphertext: number; readonly d: number; readonly n: number }
  | { readonly kind: "enigma-encrypt"; readonly plaintext: readonly number[]; readonly initial: number }
  | { readonly kind: "ecdsa-sign"; readonly d: number; readonly k: number; readonly hash: number };
export const ENIGMA_WHEEL = [1, 3, 0, 2] as const;
export const ENIGMA_REFLECTOR = [1, 0, 3, 2] as const;
/** y²=x³+2x+1 over F5; G=(0,1), prime order n=7. */
export const ECDSA_MULTIPLES = [null, [0,1], [1,3], [3,3], [3,2], [1,2], [0,4]] as const;
/** Browser-safe shape validation only. Arithmetic answers stay in evolution.ts. */
export function isEvolutionTaskShape(value: unknown): value is EvolutionTask {
 if (!value || typeof value !== "object") return false;
 const t=value as Record<string,unknown>;
 const integer=(v:unknown,n:number): v is number=>typeof v==="number"&&Number.isInteger(v)&&v>=0&&v<n;
 if(t.kind==="rsa-decrypt")return t.n===15&&t.d===3&&integer(t.ciphertext,15);
 if(t.kind==="enigma-encrypt")return integer(t.initial,4)&&Array.isArray(t.plaintext)&&t.plaintext.length===1&&t.plaintext.every(n=>integer(n,4));
 if(t.kind==="ecdsa-sign")return integer(t.d,7)&&t.d>0&&integer(t.k,6)&&t.k>=2&&integer(t.hash,7);
 return false;
}
