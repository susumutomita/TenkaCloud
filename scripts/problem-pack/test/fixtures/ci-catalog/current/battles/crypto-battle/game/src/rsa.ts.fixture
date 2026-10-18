import { pow } from "./field.ts";

/** Public, browser-safe arithmetic for a deliberately small textbook RSA lesson. */
export interface RsaPublicKey { readonly n: number; readonly e: number }
export interface RsaTask extends RsaPublicKey { readonly kind: "rsa-encrypt"; readonly plaintext: number }
export interface PublicRsaKey extends RsaPublicKey { readonly teamId: string; readonly generation: number }

export function isRsaPublicKey(value: unknown): value is RsaPublicKey {
  if (!value || typeof value !== "object") return false;
  const key = value as Record<string, unknown>;
  return Number.isInteger(key.n) && (key.n as number) >= 6 && (key.n as number) <= 77
    && [3, 5, 7].includes(key.e as number);
}

/** Strict decimal input; the teaching range also bounds all work on hostile input. */
export function parseRsaNumber(value: unknown, upperExclusive: number): number | undefined {
  if (typeof value !== "string" || !/^(0|[1-9]\d?)$/.test(value)) return undefined;
  const number = Number(value);
  return number < upperExclusive ? number : undefined;
}

export function parseRsaAnswer(value: unknown, n: number): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const answer = parseRsaNumber(value[0], n);
  return answer === undefined ? undefined : [answer];
}

export function rsaEncrypt(plaintext: number, key: RsaPublicKey): number {
  if (!isRsaPublicKey(key) || !Number.isInteger(plaintext) || plaintext < 0 || plaintext >= key.n) throw new Error("RSA: invalid public input");
  return Number(pow(BigInt(plaintext), BigInt(key.e), BigInt(key.n)));
}

export function isSmallPrime(n: number): boolean {
  if (!Number.isInteger(n) || n < 2 || n > 77) return false;
  for (let divisor = 2; divisor * divisor <= n; divisor++) if (n % divisor === 0) return false;
  return true;
}

/** The factors, in either order, prove the public task; an internal d is never compared. */
export function rsaFactorsFit(n: number, p: unknown, q: unknown): boolean {
  const a = parseRsaNumber(p, n), b = parseRsaNumber(q, n);
  return a !== undefined && b !== undefined && a !== b && isSmallPrime(a) && isSmallPrime(b) && a * b === n;
}
