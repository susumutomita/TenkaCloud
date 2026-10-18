/** Lecture week 3, slides 54–60. Honest-verifier ZK over the order-11 subgroup
 * of F_23*. Tiny parameters are for hand calculation, NOT cryptographic security.
 * Verification takes only public values; it never receives the witness x or r.
 */
export const SCHNORR = { p: 23, q: 11, g: 2 } as const;
export function power(base: number, exponent: number): number {
  let value = 1;
  for (let i = 0; i < exponent; i++) value = value * base % SCHNORR.p;
  return value;
}
export function scalar(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < SCHNORR.q;
}
export function group(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) < SCHNORR.p && power(value as number, SCHNORR.q) === 1;
}
export function verifySchnorr(y: number, a: number, e: number, z: number): boolean {
  return group(y) && group(a) && scalar(e) && scalar(z) && power(SCHNORR.g, z) === a * power(y, e) % SCHNORR.p;
}
export function simulateSchnorr(y: number, e: number, z: number): number {
  if (!group(y) || !scalar(e) || !scalar(z)) throw new Error("invalid public transcript");
  return power(SCHNORR.g, z) * power(y, (SCHNORR.q - e) % SCHNORR.q) % SCHNORR.p;
}
