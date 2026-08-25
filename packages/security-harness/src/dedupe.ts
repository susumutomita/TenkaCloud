/**
 * Deterministic-signature deduplication (Issue #3036 Phase 2 "deterministic signature による重複
 * 排除"). When Recon assigns a spare finder slot to an already-covered focus area
 * (`./recon.ts`'s round-robin redundant coverage), or when two independent Finders simply converge
 * on the same request/assertion sequence, both produce a `FinderHandoff` (`./finder-output.ts`)
 * whose *witness content* is identical once the Finder-chosen `witnessId` is stripped and header
 * order is canonicalized. This file turns that into a single stable SHA-256 signature so a
 * `DedupeManifest` groups them without ever touching Finder reasoning — there isn't any on
 * `FinderHandoff` to touch (see that file's doc comment).
 *
 * `witnessId` and `finderIndex` are deliberately EXCLUDED from the signature: `witnessId` is a
 * label the Finder chose for itself (not evidence of what was actually probed), and `finderIndex`
 * identifies who found it, not what was found. Two Finders that hit the exact same steps for the
 * same focus area must collapse to one signature regardless of how either one labeled its own
 * witness or which finder slot produced it.
 */

import { sha256Hex, toDigestRef } from "./digest.js";
import type { FinderHandoff } from "./finder-output.js";
import type { HttpWitnessStep } from "./types.js";

/**
 * Canonical JSON: object keys sorted recursively so the same logical content always serializes to
 * the same bytes regardless of construction order. Plain `JSON.stringify` does not guarantee this
 * across independently-built objects (e.g. two `HttpWitnessStep.headers` records built by
 * different Finders in a different property order), which is exactly the case this function
 * exists to normalize before hashing.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonStringify(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries
      .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJsonStringify(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalizeStep(step: HttpWitnessStep): Record<string, unknown> {
  const headers = step.headers
    ? Object.fromEntries(Object.entries(step.headers).sort(([a], [b]) => a.localeCompare(b)))
    : undefined;
  return {
    method: step.method,
    path: step.path,
    headers,
    body: step.body,
    expectStatus: step.expectStatus,
    expectBodyIncludes: step.expectBodyIncludes,
    expectBodyExcludes: step.expectBodyExcludes,
  };
}

/**
 * Deterministic signature for a candidate finding: derived ONLY from `focusArea` plus the
 * canonicalized witness steps. Same focus area + same request/assertion sequence => same
 * signature, always — regardless of `witnessId`, `finderIndex`, or `targetMetadata`.
 */
export function computeDeterministicSignature(handoff: FinderHandoff): string {
  const canonical = {
    focusArea: handoff.focusArea,
    steps: handoff.witness.steps.map(canonicalizeStep),
  };
  return toDigestRef(sha256Hex(canonicalJsonStringify(canonical)));
}

export interface DedupeGroup {
  readonly signature: string;
  /** The representative kept for this signature — the first occurrence in input order, so which handoff is "kept" is itself deterministic given a deterministic input order (e.g. ascending `finderIndex`). */
  readonly kept: FinderHandoff;
  /** Every other handoff that shared this signature. Never discarded silently — listed here for audit even though only `kept` is forwarded onward. */
  readonly duplicates: readonly FinderHandoff[];
}

export interface DedupeManifest {
  readonly groups: readonly DedupeGroup[];
  readonly totalInput: number;
  readonly totalUnique: number;
}

/**
 * Groups candidate findings by deterministic signature. Duplicate REMOVAL is order-independent
 * (the same set of handoffs in any order produces the same groups), but duplicate SELECTION is
 * order-dependent and stable (the first handoff seen for a signature is always `kept`).
 */
export function dedupeFindings(handoffs: readonly FinderHandoff[]): DedupeManifest {
  const order: string[] = [];
  const groups = new Map<string, FinderHandoff[]>();

  for (const handoff of handoffs) {
    const signature = computeDeterministicSignature(handoff);
    const existing = groups.get(signature);
    if (existing === undefined) {
      groups.set(signature, [handoff]);
      order.push(signature);
    } else {
      existing.push(handoff);
    }
  }

  const resultGroups: DedupeGroup[] = order.map((signature) => {
    const members = groups.get(signature);
    if (members === undefined || members.length === 0) {
      throw new Error(
        `dedupeFindings: internal invariant violated — no members recorded for signature ${signature}`,
      );
    }
    const [kept, ...duplicates] = members;
    return { signature, kept, duplicates };
  });

  return {
    groups: resultGroups,
    totalInput: handoffs.length,
    totalUnique: resultGroups.length,
  };
}
