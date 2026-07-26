import { describe, expect, it } from "vitest";
import {
  BLOCK_BYTES,
  BLOCK_WORDS,
  INITIAL_HASH,
  LENGTH_BYTES,
  ROUND_CONSTANTS,
  ROUNDS,
  STATE_LABELS,
} from "../src/sha256/constants";

/** 先頭 `count` 個の素数。 */
function firstPrimes(count: number): number[] {
  const primes: number[] = [];
  for (let n = 2; primes.length < count; n += 1) {
    if (primes.every((p) => p * p > n || n % p !== 0)) primes.push(n);
  }
  return primes;
}

/** 小数部の先頭 32 bit を取り出す。double の 53 bit 仮数で 32 bit は余裕がある。 */
function fractionalWord(value: number): number {
  return Math.floor((value - Math.floor(value)) * 2 ** 32);
}

describe("SHA-256 constants", () => {
  it("should match the cube roots of the first 64 primes", () => {
    const derived = firstPrimes(64).map((p) => fractionalWord(Math.cbrt(p)));
    expect(derived).toEqual([...ROUND_CONSTANTS]);
  });

  it("should match the square roots of the first 8 primes", () => {
    const derived = firstPrimes(8).map((p) => fractionalWord(Math.sqrt(p)));
    expect(derived).toEqual([...INITIAL_HASH]);
  });

  it("should keep every constant inside 32 bits", () => {
    for (const value of [...ROUND_CONSTANTS, ...INITIAL_HASH]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("should describe a 512 bit block of 16 words and 64 rounds", () => {
    expect(BLOCK_BYTES).toBe(64);
    expect(BLOCK_WORDS).toBe(16);
    expect(ROUNDS).toBe(64);
    expect(LENGTH_BYTES).toBe(8);
    expect(ROUND_CONSTANTS).toHaveLength(ROUNDS);
    expect(INITIAL_HASH).toHaveLength(STATE_LABELS.length);
    expect([...STATE_LABELS]).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });
});
