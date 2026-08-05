/**
 * [Problem SDK / Issue #2225 ← #2184 RC-28-6] `multi-verify` scoring kind.
 * Extracted verbatim from scoring-metadata.ts.
 */

import {
  clampWrongAnswerPenalty,
  type HintRevealMode,
  type ProgressiveHint,
  parseHintRevealMode,
  parseHints,
} from "./hints.js";
import { optionalNonEmptyString } from "./primitives.js";

/**
 * Issue #2252: one checkpoint of a `multi-verify` (docker local-play) problem.
 * The container owns the answer and judges a submission per checkpoint via
 * `POST /verify` (`checkpointId` in the request); the platform holds points
 * only — there is deliberately no `flagOutputKey` and no expected value here.
 */
export interface MultiVerifyCheck {
  readonly id: string;
  /** Competitor-facing label. Must not spoil the vulnerability (authoring rule). */
  readonly label: string;
  readonly points: number;
  readonly wrongAnswerPenalty?: number;
  readonly hints?: readonly ProgressiveHint[];
  /**
   * [#2876] Shape of the submitted value. `"multiline"` = the answer is source code,
   * so the portal renders a textarea; a single-line input drops the newlines on paste
   * and turns a correct answer into a wrong one. Absent = `"text"` (one line).
   */
  readonly input?: "text" | "multiline";
}

/**
 * Issue #2252: `multi-verify` kind — N independent container-judged checkpoints
 * summing to the problem total. Valid only for `runtime.provider: docker`
 * problems (`make local`); the deploy worker never sends these to a cloud.
 */
export interface MultiVerifyScoringMetadata {
  readonly kind: "multi-verify";
  readonly checks: readonly MultiVerifyCheck[];
  /**
   * Hint unlock order shared by every check's hint list; unset = `sequential`
   * (default). Top-level (not per-check) so one problem cannot mix orders — the
   * portal reveal route is keyed on `hintId` alone. See {@link HintRevealMode}.
   */
  readonly hintReveal?: HintRevealMode;
}

// #2252 contract (must match the catalog SCHEMA.json + validate-problems.ts so
// the same fixture is valid in both): id starts alphanumeric, 1–64 chars.
const MULTI_VERIFY_CHECK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MULTI_VERIFY_LABEL_MAX = 80;
const MULTI_VERIFY_MIN_CHECKS = 2;
const MULTI_VERIFY_MAX_CHECKS = 8;

/**
 * Issue #2252: narrow the multi-verify kind. Same never-partial-drop policy as
 * multi-flag — one invalid check rejects the whole object (a silently dropped
 * checkpoint would change the problem total per competitor). The structural
 * contract mirrors the catalog validator exactly so a fixture valid for the
 * catalog is valid here and vice versa: 2–8 checks; ids match
 * `^[a-z0-9][a-z0-9-]{0,63}$` and are unique; labels are non-empty and ≤80
 * chars; points are positive integers; `wrongAnswerPenalty` ≤ that check's
 * points; and hint ids are unique **across the whole problem** (the portal
 * reveal route is keyed on `hintId` alone). Tier-point totals and the 50% hint
 * cap are authoring regulation enforced catalog-side, not here (the platform
 * has no difficulty tier at runtime).
 */
export function parseMultiVerify(value: unknown): MultiVerifyScoringMetadata | undefined {
  const m = value as { checks?: unknown; hintReveal?: unknown };
  if (
    !Array.isArray(m.checks) ||
    m.checks.length < MULTI_VERIFY_MIN_CHECKS ||
    m.checks.length > MULTI_VERIFY_MAX_CHECKS
  ) {
    return undefined;
  }

  const checks: MultiVerifyCheck[] = [];
  const seenIds = new Set<string>();
  const seenHintIds = new Set<string>();
  for (const raw of m.checks) {
    const check = parseMultiVerifyCheck(raw);
    if (!check) return undefined;
    if (seenIds.has(check.id)) return undefined;
    seenIds.add(check.id);
    for (const hint of check.hints ?? []) {
      if (seenHintIds.has(hint.id)) return undefined;
      seenHintIds.add(hint.id);
    }
    checks.push(check);
  }
  const hintReveal = parseHintRevealMode(m.hintReveal);
  return { kind: "multi-verify", checks, ...(hintReveal ? { hintReveal } : {}) };
}

function parseMultiVerifyCheck(value: unknown): MultiVerifyCheck | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const c = value as {
    id?: unknown;
    label?: unknown;
    points?: unknown;
    wrongAnswerPenalty?: unknown;
    hints?: unknown;
    input?: unknown;
  };
  const id = optionalNonEmptyString(c.id);
  const label = optionalNonEmptyString(c.label);
  if (!id || !MULTI_VERIFY_CHECK_ID.test(id) || !label || label.length > MULTI_VERIFY_LABEL_MAX) {
    return undefined;
  }
  if (typeof c.points !== "number" || !Number.isInteger(c.points) || c.points <= 0) {
    return undefined;
  }
  // wrongAnswerPenalty (if present) must be a valid non-negative integer ≤ points.
  // An out-of-range value rejects the whole problem (never silently clamp a
  // checkpoint's penalty — the catalog validator rejects it too).
  if (c.wrongAnswerPenalty !== undefined) {
    const waP = c.wrongAnswerPenalty;
    if (typeof waP !== "number" || !Number.isInteger(waP) || waP < 0 || waP > c.points) {
      return undefined;
    }
  }
  const hints = parseHints(c.hints);
  if (hints) {
    const hintIds = new Set(hints.map((hint) => hint.id));
    if (hintIds.size !== hints.length) return undefined;
  }
  // [#2876] Never fall back to the one-line field on a bad value: a typo would
  // silently reinstate the paste-eats-newlines bug on a checkpoint the author
  // explicitly declared as code. Same never-partial-drop policy as the rest.
  if (c.input !== undefined && c.input !== "text" && c.input !== "multiline") return undefined;
  return {
    id,
    label,
    points: c.points,
    wrongAnswerPenalty: clampWrongAnswerPenalty(c.wrongAnswerPenalty),
    ...(hints ? { hints } : {}),
    ...(c.input !== undefined ? { input: c.input } : {}),
  };
}
