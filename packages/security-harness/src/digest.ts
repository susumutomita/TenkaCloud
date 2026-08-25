/**
 * Content-addressing helpers (Issue #3036 "Exact artifact binding").
 *
 * Every digest in this package is a pure SHA-256 of real bytes — never a random id, a
 * timestamp, or a label chosen by the caller. That is what lets `evaluatePatchVerdict`
 * (./evaluate-patch.ts) reject a stale or substituted artifact by comparing digests instead
 * of trusting a claim.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** SHA-256 of `content`, hex-encoded. Pure: same bytes always produce the same digest. */
export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Wraps a bare hex digest in the `sha256:<hex>` canonical reference form used across contracts. */
export function toDigestRef(hex: string): string {
  return `sha256:${hex}`;
}

/**
 * Content-addresses a source file by its own bytes, for a `TargetLauncher` "build" step that
 * has no real container image to hash (Phase 1's in-process fixtures — see
 * `src/fixtures/*`). This is the file the module lives in, read at call time, so changing a
 * fixture's source changes its digest exactly like changing a Dockerfile changes an image
 * digest. Never used against participant-writable paths outside this package's own fixtures.
 */
export function digestOfOwnSource(importMetaUrl: string): string {
  const path = fileURLToPath(importMetaUrl);
  return toDigestRef(sha256Hex(readFileSync(path)));
}
