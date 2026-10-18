/**
 * Issue #645 Phase 2: the additively homomorphic cipher behind FHE Orders.
 *
 * An FHE Order hands a team two ciphertexts and asks for the encryption of
 * their sum, without ever handing over the plaintexts or the key. This module
 * is the scheme that makes that a real cryptographic exercise rather than a
 * story about one.
 *
 * ## The scheme
 *
 * Over the same prime field `field.ts` already uses, with a secret key `k_i`
 * per input:
 *
 * ```text
 * Enc_i(m; r) = (r, m + k_i*r mod p)      r != 0, drawn per ciphertext
 * Dec_i(r, y) = y - k_i*r mod p
 * ```
 *
 * Adding two ciphertexts componentwise gives an encryption of the sum, under
 * the two inputs' combined mask:
 *
 * ```text
 * (r1, y1) + (r2, y2) = (r1+r2, y1+y2)
 * y1+y2 - (k1*r1 + k2*r2) = (m1 + k1*r1) + (m2 + k2*r2) - k1*r1 - k2*r2 = m1+m2
 * ```
 *
 * The judge holds that combined mask (it derives it from the Order), so it can
 * decrypt the sum and compare — see {@link decryptOrderSum}.
 *
 * That is the whole participant-facing operation: add two pairs of numbers and
 * take the remainder. No library, no lattice, no noise budget -- and it is not
 * a toy in the pejorative sense. It is genuinely additively homomorphic and
 * genuinely hides its plaintext, which are exactly the two properties an FHE
 * Order needs to teach.
 *
 * ## Why this scheme and not a "real" FHE library
 *
 * #645's non-goals say so directly: 「実用 FHE / MPC ライブラリの性能 benchmark を
 * 競うこと」 is out of scope. What is in scope is that a participant computes on
 * data they cannot read, and that the judge -- not the participant -- decides
 * whether the answer is right. A BFV/CKKS dependency would add megabytes, a
 * noise-growth failure mode with nothing to teach at this level, and numbers no
 * participant could check by hand. This scheme keeps every one of #645's FHE
 * acceptance criteria and stays inside §12b's arithmetic (add, multiply,
 * remainder).
 *
 * What it is NOT is fully homomorphic: there is no multiplication of two
 * ciphertexts here, only addition and multiplication by a public constant. The
 * participant-facing copy says "encrypted addition", never "FHE can do
 * anything" -- claiming otherwise would be teaching something false.
 *
 * ## What it hides, precisely
 *
 * Given `(r, y)` with `r != 0` and no knowledge of `k`, every candidate
 * plaintext `m'` is consistent: take `k' = (y - m') * r^-1 mod p`, which exists
 * because `p` is prime and `r != 0`. One ciphertext therefore carries *no*
 * information about its plaintext -- information-theoretic, not a hardness
 * assumption, and `fhe.test.ts` executes it rather than asserting it.
 *
 * That argument needs every such `k'` to be a key the derivation can actually
 * produce, which is why {@link deriveFheKey} is uniform over the whole field.
 * An earlier version excluded `k = 0` and so ruled out exactly one candidate
 * (`m' = y`) while doubling another's likelihood -- and the test missed it by
 * solving for `k'` without ever asking whether that `k'` was emittable. It now
 * asks.
 *
 * **Each input gets its OWN key, and that is load-bearing.** An earlier version
 * of this module used one key for both of an Order's inputs and claimed the
 * pair was still perfectly hiding, reasoning "two equations, three unknowns".
 * That was wrong. With a shared `k`, anyone holding the published pair can
 * compute
 *
 * ```text
 * r2*y1 - r1*y2 = r2*m1 - r1*m2   (mod p)
 * ```
 *
 * -- the `k` terms cancel -- which pins `(m1, m2)` to a line: `p` possible
 * pairs out of `p^2`, not all of them. The leak was of a linear relation rather
 * than of either value, and it did not make the Order forgeable, but it is
 * exactly the kind of "looks hidden, is not" that this problem exists to teach
 * people to notice, so the scheme does not ship with it.
 *
 * With independent `k1`, `k2` the same computation gives
 * `r2*y1 - r1*y2 = r2*m1 - r1*m2 + r1*r2*(k1 - k2)`, and `k1 - k2` is an
 * unknown uniform value, so nothing is pinned: for ANY `(m1, m2)` there is a
 * key pair producing the published ciphertexts. `fhe.test.ts` executes that
 * JOINT statement, not only the single-ciphertext one -- the weaker test is
 * what let the original claim stand.
 *
 * Keys are also bound to the Order (see {@link deriveFheInputKeys}), so nothing
 * a participant later learns about one Order can unlock another.
 *
 * ## Why the participant cannot fake an answer
 *
 * The judge decrypts the submitted ciphertext and compares against the hidden
 * expected sum (#645: 「judge が decrypt + expected value compare で採点する」).
 * A participant who KNEW the expected sum could submit a ciphertext for it
 * directly -- and cannot, because the plaintexts are full field elements
 * derived from the match seed, so the sum is one value out of ~2^61. Producing
 * the right value any other way needs the keys, which the paragraph above says
 * they cannot learn. So the only tractable route to a passing submission is to
 * actually perform the homomorphic addition.
 */

import { add, mod, mul, sub } from "./field.ts";
import { deriveBigInt } from "./prng.ts";

/**
 * One ciphertext, in this module's `bigint` working form.
 *
 * The state/op wire shape uses stringified decimals instead
 * (`StoredCiphertext` in types.ts) -- see types.ts's "JSON-SAFETY INVARIANT".
 */
export interface Ciphertext {
  readonly r: bigint;
  readonly y: bigint;
}

/**
 * The key protecting input `index` of one Order.
 *
 * Bound to BOTH the Order and the input index. The Order binding stops anything
 * learned about one Order unlocking another; the index binding is what keeps
 * the published pair jointly hiding — see this module's header for the linear
 * relation a shared key would expose.
 *
 * Derived from the match seed, never stored: `CryptoBattleState` holds the
 * public ciphertexts and nothing else, so there is no new secret field for
 * `projectForTeam` to have to remember to redact.
 */
export function deriveFheKey(seed: string, orderId: string, index: number, p: bigint): bigint {
  // Uniform over the WHOLE field, zero included. An earlier version excluded
  // `k = 0`, reasoning that it "would make Enc(m; r) = (r, m) -- the plaintext
  // in the clear". That reasoning was wrong, and the exclusion actively broke
  // the property it was meant to protect.
  //
  // Wrong because `k` is never published: `(r, m)` is only "in the clear" to
  // someone who already knows `k = 0`, and nobody does. Harmful because
  // remapping 0 to 1 makes key 0 impossible and key 1 twice as likely, so the
  // candidate plaintext `m' = y` -- the one needing `k' = 0` -- becomes
  // INCONSISTENT, and the module header's claim that every candidate remains
  // possible stops being true.
  //
  // With `k` uniform over `F_p` and any fixed `r != 0`, `k*r` is uniform, so
  // `y = m + k*r` is uniform and independent of `m`. That is the perfect
  // hiding this scheme claims, and it needs the zero back.
  //
  // `r` is the opposite case and keeps its exclusion -- see
  // {@link deriveRandomness}.
  return deriveBigInt(seed, `fhe-key:${orderId}`, index, p);
}

/** One key per input, in input order. */
export function deriveFheInputKeys(seed: string, orderId: string, p: bigint): readonly bigint[] {
  return deriveFhePlaintexts(seed, orderId, p).map((_unused, index) =>
    deriveFheKey(seed, orderId, index, p),
  );
}

/**
 * The plaintexts an FHE Order asks a team to add, without showing them.
 *
 * Trusted-side only: the judge re-derives these to compute the expected sum.
 * Nothing hands them to a participant, and `fhe.test.ts` pins that the Order's
 * public payload does not contain them.
 */
export function deriveFhePlaintexts(seed: string, orderId: string, p: bigint): readonly bigint[] {
  return [
    deriveBigInt(seed, `fhe-plaintext-a:${orderId}`, 0, p),
    deriveBigInt(seed, `fhe-plaintext-b:${orderId}`, 0, p),
  ];
}

/**
 * The per-ciphertext randomness `r`.
 *
 * Forced non-zero, and unlike the key this exclusion is load-bearing: `r` is
 * PUBLISHED as half the ciphertext, so `r = 0` collapses `Enc(m; 0)` to
 * `(0, m)` and any reader can see both that `r` is zero and therefore that `y`
 * is the plaintext. The key's zero is unobservable; this one is not.
 *
 * Biasing `r` costs nothing in return: hiding is stated for a given `r != 0`,
 * and for ANY fixed such `r` the argument above goes through unchanged, so how
 * `r` itself is distributed never enters it.
 */
function deriveRandomness(seed: string, orderId: string, index: number, p: bigint): bigint {
  const r = deriveBigInt(seed, `fhe-randomness:${orderId}`, index, p);
  return r === 0n ? 1n : r;
}

/** `Enc(plaintext; randomness)` under `key`. */
export function encrypt(plaintext: bigint, key: bigint, randomness: bigint, p: bigint): Ciphertext {
  return { r: mod(randomness, p), y: add(plaintext, mul(key, randomness, p), p) };
}

/** `Dec(ciphertext)` under `key`. */
export function decrypt(ciphertext: Ciphertext, key: bigint, p: bigint): bigint {
  return sub(ciphertext.y, mul(key, ciphertext.r, p), p);
}

/**
 * Componentwise addition -- an encryption of the sum of the two plaintexts.
 *
 * This is the operation the participant performs. It is exported so the
 * reference solution, the tests, and the dev harness all run the same code a
 * participant would write, rather than three descriptions of it.
 */
export function addCiphertexts(a: Ciphertext, b: Ciphertext, p: bigint): Ciphertext {
  return { r: add(a.r, b.r, p), y: add(a.y, b.y, p) };
}

/**
 * The public payload of one FHE Order: the ciphertexts a team is asked to add.
 *
 * Deterministic in `(seed, orderId)`, so the judge can re-derive both the
 * inputs and the expected answer without either being stored.
 */
export function deriveFheOrderInputs(seed: string, orderId: string, p: bigint): readonly Ciphertext[] {
  return deriveFhePlaintexts(seed, orderId, p).map((plaintext, index) =>
    encrypt(
      plaintext,
      deriveFheKey(seed, orderId, index, p),
      deriveRandomness(seed, orderId, index, p),
      p,
    ),
  );
}

/**
 * The combined mask on an Order's summed ciphertext: `SUM_i k_i * r_i`.
 *
 * With one key per input there is no single scalar that decrypts the sum, so
 * the Order's own mask total is what {@link decryptOrderSum} subtracts. That is
 * a property of the Order, not a new secret: it is derived from the seed on
 * demand and never stored.
 */
function orderMaskSum(seed: string, orderId: string, p: bigint): bigint {
  return deriveFheOrderInputs(seed, orderId, p).reduce(
    (acc, ciphertext, index) =>
      add(acc, mul(deriveFheKey(seed, orderId, index, p), ciphertext.r, p), p),
    0n,
  );
}

/**
 * Decrypt a submitted sum for this Order.
 *
 * This is the judge's decrypt half of #645's decrypt-and-compare rule, and it
 * is only that half: it reads `y` alone. That is NOT a statement that `r` may
 * be anything. Because the mask total is fixed for an Order, exactly one `y` is
 * ever accepted -- which leaves `r` the only free component, and an unchecked
 * `r` would admit `(0, y1 + y2)`: half the componentwise addition the Order
 * asks for. `reducer.ts` checks `r` against the Order's own first components
 * before calling this. The split is deliberate: this function is the
 * decryption, not the verdict.
 */
export function decryptOrderSum(
  ciphertext: Ciphertext,
  seed: string,
  orderId: string,
  p: bigint,
): bigint {
  return sub(ciphertext.y, orderMaskSum(seed, orderId, p), p);
}

/** The plaintext a correct submission must decrypt to. Trusted-side only. */
export function expectedFheSum(seed: string, orderId: string, p: bigint): bigint {
  return deriveFhePlaintexts(seed, orderId, p).reduce((acc, m) => add(acc, m, p), 0n);
}
