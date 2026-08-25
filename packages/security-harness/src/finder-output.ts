/**
 * Finder output -> Verifier handoff schema restriction (Issue #3036 "PoC-only handoff": "Finder
 * から Verifier へ渡せるのは、schema validation 済みの witness bundle と最小限の target metadata
 * だけとする。Finder の推論、自己評価、severity、結論を verifier prompt へ入れない").
 *
 * A Finder's raw model output is untrusted text — the model ran against attacker-controlled/
 * untrusted target source, so its own narration about what it found is not evidence and must
 * never reach a Verifier or a score. `extractFinderHandoff` is the ONLY function in this package
 * that turns that raw text into something the orchestrator forwards, and it enforces the
 * restriction TWICE, independently:
 *
 *   1. Structurally: `FinderHandoff` has no `reasoning` / `selfAssessedSeverity` / `severity` /
 *      `confidence` / `conclusion` field. Even a bug that tried to forward one would be a TypeScript
 *      compile error, not a silent runtime leak.
 *   2. At the parse boundary: any top-level field in the Finder's raw JSON claim other than
 *      `witness` / `targetMetadata` is rejected OUTRIGHT — the whole claim fails to parse (`ok:
 *      false`, no `handoff` at all) rather than being silently stripped down to the allowed
 *      fields. A Finder that tries to smuggle reasoning alongside a perfectly valid witness gets
 *      NO handoff, not a laundered one — matching this package's existing "unknown field を拒否
 *      する" convention in `./witness.ts` and `./validators.ts`.
 *
 * The witness itself is validated with the SAME `validateHttpSequenceWitness` used everywhere else
 * in this package (`./witness.ts`) — there is no separate, looser Finder-specific witness parser
 * that could drift from the evidence boundary the rest of the harness enforces.
 */

import type { HttpSequenceWitness } from "./types.js";
import { validateHttpSequenceWitness } from "./witness.js";

/** Minimal target metadata the issue permits alongside the witness bundle — nothing else. */
export interface FinderTargetMetadata {
  readonly targetId?: string;
  readonly endpointHint?: string;
}

/**
 * The ONLY payload a Finder may hand toward independent verification. See the file doc comment
 * for why no reasoning/self-assessment/severity/conclusion field exists on this type.
 */
export interface FinderHandoff {
  readonly focusArea: string;
  readonly finderIndex: number;
  readonly witness: HttpSequenceWitness;
  readonly targetMetadata: FinderTargetMetadata;
}

export interface FinderHandoffResult {
  readonly ok: boolean;
  readonly handoff?: FinderHandoff;
  readonly errors: readonly string[];
}

export interface ExtractFinderHandoffInput {
  /** The focus area this Finder was assigned by Recon (`./recon.ts`'s `ReconFinderAssignment.focusArea`) — used to check the claimed witness against what this Finder was actually asked to search, not just to label the output. */
  readonly focusArea: string;
  readonly finderIndex: number;
  /** Raw, untrusted `ModelProviderResponse.outputText` (`./model-provider.ts`) — expected to be a JSON object, never executed or interpolated as anything but data. */
  readonly rawOutputText: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KNOWN_CLAIM_FIELDS: ReadonlySet<string> = new Set(["witness", "targetMetadata"]);
const KNOWN_TARGET_METADATA_FIELDS: ReadonlySet<string> = new Set(["targetId", "endpointHint"]);

/**
 * Rejects the ENTIRE claim (not just the offending field) the moment any field outside
 * `witness`/`targetMetadata` is present. See the file doc comment for why this is a hard reject,
 * not a strip-and-continue.
 */
function checkNoForbiddenTopLevelFields(value: Record<string, unknown>, errors: string[]): void {
  for (const key of Object.keys(value)) {
    if (!KNOWN_CLAIM_FIELDS.has(key)) {
      errors.push(
        `finder output: field "${key}" is not part of the PoC-only handoff schema and was rejected — ` +
          "Finder reasoning, self-assessment, severity, and conclusions never reach a Verifier",
      );
    }
  }
}

function extractTargetMetadata(value: unknown, errors: string[]): FinderTargetMetadata {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    errors.push("targetMetadata: expected an object");
    return {};
  }
  for (const key of Object.keys(value)) {
    if (!KNOWN_TARGET_METADATA_FIELDS.has(key)) {
      errors.push(`targetMetadata: unknown field "${key}"`);
    }
  }
  const metadata: { targetId?: string; endpointHint?: string } = {};
  if (value.targetId !== undefined) {
    if (typeof value.targetId !== "string") {
      errors.push("targetMetadata.targetId: must be a string");
    } else {
      metadata.targetId = value.targetId;
    }
  }
  if (value.endpointHint !== undefined) {
    if (typeof value.endpointHint !== "string") {
      errors.push("targetMetadata.endpointHint: must be a string");
    } else {
      metadata.endpointHint = value.endpointHint;
    }
  }
  return metadata;
}

/**
 * Strict-parses a Finder's raw model output into the ONLY thing allowed to move toward
 * verification: a schema-validated witness plus minimal target metadata. Never throws — a
 * malformed or boundary-violating claim is expected, untrusted input, not a programming error, so
 * it is reported as `{ ok: false, errors }` like every other validator in this package.
 */
export function extractFinderHandoff(input: ExtractFinderHandoffInput): FinderHandoffResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawOutputText);
  } catch {
    return { ok: false, errors: ["finder output: not valid JSON"] };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, errors: ["finder output: expected a JSON object"] };
  }

  const errors: string[] = [];
  checkNoForbiddenTopLevelFields(parsed, errors);
  if (errors.length > 0) {
    // A forbidden field is disqualifying on its own — do not also report witness/targetMetadata
    // errors for a claim that is being rejected wholesale regardless.
    return { ok: false, errors };
  }

  const targetMetadata = extractTargetMetadata(parsed.targetMetadata, errors);
  const witnessResult = validateHttpSequenceWitness(parsed.witness);
  if (!witnessResult.ok || witnessResult.value === undefined) {
    errors.push(...witnessResult.errors);
    return { ok: false, errors };
  }

  if (witnessResult.value.focusArea !== input.focusArea) {
    errors.push(
      `finder output: witness.focusArea "${witnessResult.value.focusArea}" does not match ` +
        `this finder's assigned focus area "${input.focusArea}"`,
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    handoff: {
      focusArea: input.focusArea,
      finderIndex: input.finderIndex,
      witness: witnessResult.value,
      targetMetadata,
    },
    errors: [],
  };
}
