/**
 * The one untrusted-decimal gate every participant-submitted number passes
 * through before `BigInt()` sees it.
 *
 * Lived in `schnorr-verifier.ts` until #709 retired the Schnorr PROVE; the
 * rule is unchanged and so is the reason for it, so it moved rather than being
 * rewritten. See `parseCanonicalDecimal` below.
 */

/**
 * The largest decimal this package ever needs to parse has ~19 digits (a
 * `field.ts` `P` element); 700 leaves a generous margin without opening the
 * door to an absurdly long input. Kept from the 2048-bit era on purpose: the
 * bound is about parse cost, not about any value space.
 */
const MAX_DECIMAL_DIGITS = 700;

/** Digits only, no sign, no leading/embedded/trailing whitespace, length-bounded. */
const CANONICAL_DECIMAL = new RegExp(`^\\d{1,${MAX_DECIMAL_DIGITS}}$`);

/**
 * Parse an untrusted, participant-submitted decimal string into a `bigint`,
 * or `undefined` if it is not a canonical, length-bounded decimal literal.
 * MUST run before any `BigInt()` call on untrusted input: `BigInt()`'s parse
 * cost is superlinear in input length, and JavaScriptCore additionally
 * enforces a hard size cap somewhere past 300,000 digits, throwing
 * `RangeError: Out of memory` -- so an unguarded `BigInt()` on wire input is a
 * CPU-exhaustion vector well within that cap. Rejecting anything that is not
 * `/^\d{1,700}$/` up front closes this off before `BigInt()` ever runs, and as
 * a side effect rejects every non-canonical encoding `BigInt()` would accept
 * (a `"0x..."` literal, a leading `"+"`, whitespace, a `"-"` sign), so there
 * is exactly one parse path this package trusts.
 *
 * `value` is typed `unknown`, not `string`: every caller sits at a JSON wire
 * boundary where the static annotation is not a runtime guarantee -- a JSON
 * *number* would otherwise coerce through `RegExp.prototype.test` as if it
 * were its decimal string.
 */
export function parseCanonicalDecimal(value: unknown): bigint | undefined {
  if (typeof value !== "string") return undefined;
  if (!CANONICAL_DECIMAL.test(value)) return undefined;
  return BigInt(value);
}
