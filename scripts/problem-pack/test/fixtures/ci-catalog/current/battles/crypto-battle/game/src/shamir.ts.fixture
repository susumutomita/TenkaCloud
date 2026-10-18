/**
 * Shamir (t, n) threshold secret sharing over F_p, via polynomial evaluation
 * and Lagrange interpolation.
 *
 * This is a fresh implementation for this Battle, not a reuse of
 * `challenges/ac26-w2-secret-sharing/local/reference/sharing.py` -- that
 * reference is *additive* n-out-of-n sharing (every party required, no
 * threshold), a different primitive from the (t, n) threshold scheme here
 * (see that file's docstring and this repo's AGENTS.md working notes).
 *
 * Construction: f(x) = secret + c1*x + c2*x^2 + ... + c_{t-1}*x^{t-1}, shares
 * are (i, f(i)) for i = 1..n (x = 0 is reserved for the secret itself and is
 * never handed out as a share). Any t of the n shares reconstruct f via
 * Lagrange interpolation at x = 0; fewer than t shares are, information-
 * theoretically, consistent with *every* possible secret -- that is exactly
 * what `completeShares` makes executable (see its docstring).
 */

import { add, inv, mod, mul, P, sub } from "./field.ts";

export interface Share {
  readonly index: number;
  readonly value: bigint;
}

/**
 * Split `secret` into `n` shares of a degree-(t-1) polynomial.
 *
 * `coeffs` must supply exactly `t - 1` coefficients (c1..c_{t-1}); the caller
 * (fixtures.ts in this package) is responsible for deriving them
 * deterministically -- this function never generates its own randomness (see
 * prng.ts header on why).
 */
export function share(secret: bigint, t: number, n: number, coeffs: readonly bigint[], p: bigint = P): Share[] {
  if (!Number.isInteger(t) || t < 1) {
    throw new RangeError(`shamir.share: threshold t must be a positive integer, got ${t}`);
  }
  if (!Number.isInteger(n) || n < t) {
    throw new RangeError(`shamir.share: n (${n}) must be >= threshold t (${t})`);
  }
  if (coeffs.length !== t - 1) {
    throw new RangeError(`shamir.share: expected ${t - 1} coefficients for threshold ${t}, got ${coeffs.length}`);
  }

  const evalAt = (x: bigint): bigint => {
    let acc = mod(secret, p);
    let xPow = x;
    for (const c of coeffs) {
      acc = add(acc, mul(c, xPow, p), p);
      xPow = mul(xPow, x, p);
    }
    return acc;
  };

  const shares: Share[] = [];
  for (let i = 1; i <= n; i += 1) {
    shares.push({ index: i, value: evalAt(BigInt(i)) });
  }
  return shares;
}

/** Reject a share list that reuses the same party index more than once. */
function assertDistinctIndices(points: readonly { readonly index: number }[], context: string): void {
  const seen = new Set<number>();
  for (const point of points) {
    if (seen.has(point.index)) {
      throw new RangeError(`${context}: duplicate share index ${point.index}`);
    }
    seen.add(point.index);
  }
}

/**
 * Evaluate the unique degree-(<=points.length-1) polynomial through `points`
 * at `x`, via Lagrange interpolation. Shared by reconstruct() (x = 0) and
 * completeShares() (arbitrary x).
 */
function lagrangeEvalAt(points: readonly Share[], x: bigint, p: bigint): bigint {
  let acc = 0n;
  for (const pi of points) {
    const xi = BigInt(pi.index);
    let num = 1n;
    let den = 1n;
    for (const pj of points) {
      if (pj.index === pi.index) continue;
      const xj = BigInt(pj.index);
      num = mul(num, sub(x, xj, p), p);
      den = mul(den, sub(xi, xj, p), p);
    }
    acc = add(acc, mul(pi.value, mul(num, inv(den, p), p), p), p);
  }
  return acc;
}

/**
 * Reconstruct the secret f(0) from `shares` via Lagrange interpolation.
 *
 * Deliberately does NOT check `shares.length >= t` -- "the math stays honest"
 * (per this package's design notes): interpolation through fewer than t
 * points still returns *a* value, just not (with overwhelming probability)
 * the real secret, exactly like a real attacker who does not know the
 * threshold would experience. The only thing rejected here is duplicate
 * indices, which would make the interpolation ill-defined (division by a
 * zero denominator).
 */
export function reconstruct(shares: readonly Share[], p: bigint = P): bigint {
  if (shares.length === 0) {
    throw new RangeError("shamir.reconstruct: no shares given");
  }
  assertDistinctIndices(shares, "shamir.reconstruct");
  return lagrangeEvalAt(shares, 0n, p);
}

/**
 * Executable "threshold" counterexample: given `t - 1` partial shares and any
 * candidate secret, construct the unique degree-(t-1) polynomial through
 * (0, candidateSecret) and those `t - 1` points, and return an evaluator for
 * it at arbitrary party indices.
 *
 * This is the Shamir analogue of
 * `challenges/ac26-w2-secret-sharing`'s `complete_shares`: it demonstrates
 * that `t - 1` shares are consistent with *every* possible secret (pick any
 * candidate, get back a share set that reconstructs to exactly that
 * candidate) -- i.e. fewer than t shares carry zero information about the
 * true secret. `partialShares` need not actually number `t - 1`; the caller
 * decides how many points to fix, and the returned evaluator is defined by
 * exactly `partialShares.length + 1` points (the candidate secret plus the
 * partials).
 */
export function completeShares(
  partialShares: readonly Share[],
  candidateSecret: bigint,
  p: bigint = P,
): (index: number) => bigint {
  const points: Share[] = [{ index: 0, value: mod(candidateSecret, p) }, ...partialShares];
  assertDistinctIndices(points, "shamir.completeShares");
  return (index: number): bigint => lagrangeEvalAt(points, BigInt(index), p);
}
