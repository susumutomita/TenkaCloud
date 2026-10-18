/** Small arithmetic models. No production encryption or signing keys. */
import {ECDSA_MULTIPLES, ENIGMA_WHEEL, ENIGMA_REFLECTOR, isEvolutionTaskShape, type EvolutionTask} from "./evolution-model.ts";
export {ECDSA_MULTIPLES, ENIGMA_WHEEL, ENIGMA_REFLECTOR, type EvolutionTask} from "./evolution-model.ts";
const mod = (x: number, n: number) => ((x % n) + n) % n;
/** Advance before encoding. Reflect, then traverse the inverse wiring. */
export function enigmaEncrypt(input: readonly number[], initial: number): number[] {
  return input.map((m, i) => {
    const pos = mod(initial + i + 1, 4);
    const forward = mod(ENIGMA_WHEEL[mod(m + pos, 4)]! - pos, 4);
    const reflected = ENIGMA_REFLECTOR[forward]!;
    return mod(ENIGMA_WHEEL.indexOf(mod(reflected + pos, 4) as 0|1|2|3) - pos, 4);
  });
}
export function inverse7(x: number): number {
  for (let i=1;i<7;i++) if (mod(x*i,7)===1) return i;
  throw new Error("No inverse modulo7");
}
export function evolutionAnswer(task: EvolutionTask): readonly number[] {
  if (task.kind === "rsa-decrypt") return [Number(BigInt(task.ciphertext)**BigInt(task.d)%BigInt(task.n))];
  if (task.kind === "enigma-encrypt") return enigmaEncrypt(task.plaintext, task.initial);
  const r = ECDSA_MULTIPLES[task.k]![0];
  return [r, mod(inverse7(task.k)*(task.hash+task.d*r),7)];
}
export function evolutionTask(kind: EvolutionTask["kind"], bytes: readonly number[]): EvolutionTask {
  if (kind === "rsa-decrypt") { const m=bytes[0]!%9+1; return {kind,ciphertext:m**3%15,d:3,n:15}; }
  if (kind === "enigma-encrypt") return {kind, initial: bytes[0]!%4, plaintext: bytes.slice(1,2).map(x=>x%4)};
  const d = bytes[0]!%6+1, k = bytes[1]!%4+2;
  let hash=bytes[2]!%7;
  const r=ECDSA_MULTIPLES[k]![0];
  if (mod(hash+d*r,7)===0) hash=mod(hash+1,7);
  return {kind,d,k,hash};
}
export function parseEvolutionAnswer(answer: unknown): readonly number[] | undefined {
  return typeof answer === "string" && /^[0-9]( [0-9])?$/.test(answer) ? answer.split(" ").map(Number) : undefined;
}
export function isEvolutionTask(task: EvolutionTask): boolean {
  return isEvolutionTaskShape(task) && (task.kind !== "ecdsa-sign" || evolutionAnswer(task)[1] !== 0);
}
