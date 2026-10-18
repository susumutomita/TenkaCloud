/**
 * BigInt arithmetic over F_p (prime field).
 *
 * Every function is pure and total for a > 0 prime p: no `Date.now()`, no
 * `Math.random()`, no I/O. This is deliberate -- the whole game/ package is a
 * trusted-side pure reducer (see reducer.ts header) and cryptographic
 * correctness must never depend on wall-clock or platform randomness.
 *
 * Default prime: P = 2^61 - 1, a Mersenne prime. Large enough that brute-force
 * guessing a secret is infeasible for the playtest match length, small enough
 * that every value fits in a single 64-bit-ish BigInt limb (no performance
 * cost from arbitrary-precision arithmetic in a hot reducer path).
 */

/** Default field modulus: the Mersenne prime 2^61 - 1. */
export const P = 2n ** 61n - 1n;

/**
 * [Issue #696, #707] The field an actual MATCH runs in: the prime 97.
 *
 * Not a security parameter -- a legibility one. Every Order in this Battle is
 * arithmetic the participant performs themselves, and at 2^61 - 1 that meant
 * adding nineteen-digit numbers under a five-minute deadline. The live
 * two-team run measured what that produces: a correct method, a carry slip in
 * the fourteenth digit, and a REJECTED banner that taught nothing. Homomorphic
 * addition, masked subtotals and Lagrange interpolation are structurally
 * identical at any modulus, so the modulus should be the size a person can
 * actually work in. At 97 every number on an Order is two digits, an FHE or MPC
 * answer is one two-digit addition and one subtraction, and a HUNT over three
 * consecutive shares is `3*y1 - 3*y2 + y3` -- three-digit intermediates at most.
 * 251 was the first cut (#696) and the live run still called it too much; the
 * owner's bar is 「2 桁程度」, and 97 is the largest prime under it.
 *
 * Shrinking the field costs the secret its unguessability, so it is sound ONLY
 * alongside `CryptoBattleConfig.maxHuntAttemptsPerTarget`: three tries against
 * a 97-element space, at `scores.wrongHunt` apiece, keeps interpolating the
 * shares strictly cheaper than guessing. Changing one of the two without the
 * other reopens the hole -- see that field's doc comment.
 *
 * `P` above stays the module default because `field.ts` is a general F_p
 * library and its own tests exercise a large modulus; nothing in a match
 * reaches these functions without an explicit `p` from `config.prime`.
 */
export const HAND_PRIME = 97n;

/** Reduce `a` into the canonical representative range [0, p). */
export function mod(a: bigint, p: bigint = P): bigint {
  const r = a % p;
  return r < 0n ? r + p : r;
}

export function add(a: bigint, b: bigint, p: bigint = P): bigint {
  return mod(a + b, p);
}

export function sub(a: bigint, b: bigint, p: bigint = P): bigint {
  return mod(a - b, p);
}

export function mul(a: bigint, b: bigint, p: bigint = P): bigint {
  return mod(a * b, p);
}

/** Modular exponentiation by repeated squaring. `exp` must be >= 0. */
export function pow(base: bigint, exp: bigint, p: bigint = P): bigint {
  if (exp < 0n) {
    throw new RangeError(`field.pow: negative exponent ${exp} (use inv() first)`);
  }
  let result = 1n;
  let b = mod(base, p);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mul(result, b, p);
    b = mul(b, b, p);
    e >>= 1n;
  }
  return result;
}

/**
 * Modular multiplicative inverse via the extended Euclidean algorithm.
 *
 * Deliberately not Fermat's little theorem (`pow(a, p-2, p)`) -- the extended
 * Euclidean algorithm works for any modulus (not only primes) and is the
 * textbook construction this problem's README teaches from, so the
 * implementation should read the same way the participant-facing material
 * describes it.
 */
export function inv(a: bigint, p: bigint = P): bigint {
  const x = mod(a, p);
  if (x === 0n) {
    throw new RangeError("field.inv: 0 has no multiplicative inverse");
  }
  let [oldR, r] = [x, p];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  // oldR is now gcd(x, p); for prime p and x != 0 (mod p) this is always 1.
  if (oldR !== 1n) {
    throw new RangeError(`field.inv: ${a} is not invertible mod ${p} (gcd = ${oldR})`);
  }
  return mod(oldS, p);
}
