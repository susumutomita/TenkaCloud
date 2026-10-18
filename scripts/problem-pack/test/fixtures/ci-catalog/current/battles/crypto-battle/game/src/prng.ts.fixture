/**
 * Deterministic BigInt derivation: seed string -> SHA-256 counter stream -> field
 * element.
 *
 * Reducers in this package (reducer.ts, fixtures.ts) must be pure functions of
 * their explicit arguments: same seed + same op/tick sequence => same state,
 * always (see reducer.ts "determinism" contract, and adversarial test #8).
 * `Date.now()` and `Math.random()` are therefore banned anywhere under src/ --
 * every "random-looking" value (secrets, Shamir coefficients, contract
 * schedules) is instead derived from a caller-supplied seed via this module.
 *
 * The construction is intentionally simple and auditable: hash
 * `seed | label | counter` with SHA-256, and interpret the digest as a
 * big-endian unsigned integer reduced into the field. `label` namespaces
 * independent streams from the same seed (e.g. "secret:teamA:gen1" vs
 * "coeffs:teamA:gen1") so they never collide; `counter` walks a single stream
 * forward (e.g. successive Shamir coefficients).
 *
 * This is a keystream-style construction, not a cryptographically vetted PRG --
 * it only has to be deterministic and look uniform enough for fixture/test
 * purposes. It must never be used to generate anything a real deployment
 * treats as secret entropy.
 */

import { createHash } from "node:crypto";
import { mod, P } from "./field.ts";

/** SHA-256 of `seed | label | counter`, as a Buffer (32 bytes). */
export function deriveBytes(seed: string, label: string, counter: number): Buffer {
  return createHash("sha256").update(`${seed}|${label}|${counter}`, "utf8").digest();
}

/** One field element derived from `seed | label | counter`. */
export function deriveBigInt(seed: string, label: string, counter: number, p: bigint = P): bigint {
  const bytes = deriveBytes(seed, label, counter);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return mod(value, p);
}

/** `count` field elements derived from the same (seed, label) stream, counters 0..count-1. */
export function deriveStream(seed: string, label: string, count: number, p: bigint = P): bigint[] {
  if (count < 0) {
    throw new RangeError(`prng.deriveStream: negative count ${count}`);
  }
  return Array.from({ length: count }, (_unused, i) => deriveBigInt(seed, label, i, p));
}
