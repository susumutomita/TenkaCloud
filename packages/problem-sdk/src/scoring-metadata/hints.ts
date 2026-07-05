/**
 * [Problem SDK / Issue #2225 ← #2184 RC-28-6] Progressive-hint shape + the
 * `wrongAnswerPenalty` clamp shared by every submission-based scoring kind
 * (`flag` / `multi-flag` / `multi-verify`). Extracted verbatim from
 * scoring-metadata.ts.
 */

/**
 * Issue #742 Phase 1: progressive hint shape.
 *   - id: stable identifier (so reveal records do not drift on metadata reorder)
 *   - content: display text (markdown allowed)
 *   - penalty: positive integer subtracted from `points` on reveal (0 allowed)
 * Backward compat: legacy `hints: string[]` is converted to
 * `{ id: \`hint-${index + 1}\`, content, penalty: 0 }`.
 */
export interface ProgressiveHint {
  readonly id: string;
  readonly content: string;
  readonly penalty: number;
}

/**
 * How a problem's progressive hints unlock.
 *   - `sequential` (default): hint N opens only after hints 1..N-1 are revealed
 *     (the original #1315 progressive-gate behavior — escalating penalties stay
 *     meaningful because you cannot skip straight to the last hint).
 *   - `flat`: every hint is independently revealable in any order.
 * Authored top-level under `scoring` (`"hintReveal": "flat"`), it governs every
 * hint group in the problem (the single `flag`/`verify` list, or each
 * `multi-verify` check's list). Sequential is the backward-compatible default,
 * so an unset / invalid value keeps existing problems unchanged.
 */
export type HintRevealMode = "sequential" | "flat";

/**
 * Narrow the optional `scoring.hintReveal` field. Only the two literals are
 * honored; anything else (absent / typo / wrong type) resolves to `undefined`,
 * which every consumer treats as `sequential`. Kept faithful (does not collapse
 * an explicit `"sequential"` to `undefined`) so a round-trip preserves intent.
 */
export function parseHintRevealMode(value: unknown): HintRevealMode | undefined {
  return value === "flat" || value === "sequential" ? value : undefined;
}

/**
 * Issue #817: wrongAnswerPenalty is optional. Invalid (negative / non-integer /
 * non-number) clamps to undefined (= no penalty, safe side).
 */
export function clampWrongAnswerPenalty(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    Number.isInteger(value)
    ? value
    : undefined;
}

/**
 * Issue #742 Phase 1: normalize hints v1 (string[]) and v2 (object[]) to a common
 * `ProgressiveHint[]`. Invalid elements are filtered (so a partial hint typo does
 * not stop a deploy).
 */
export function parseHints(value: unknown): readonly ProgressiveHint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const hints = value
    .map((hint, index) => parseHint(hint, index))
    .filter((hint): hint is ProgressiveHint => hint !== undefined);
  return hints.length > 0 ? hints : undefined;
}

function parseHint(value: unknown, index: number): ProgressiveHint | undefined {
  if (typeof value === "string") {
    return { id: `hint-${index + 1}`, content: value, penalty: 0 };
  }
  if (!value || typeof value !== "object") return undefined;
  const hint = value as { id?: unknown; content?: unknown; penalty?: unknown };
  if (typeof hint.id !== "string" || hint.id.length === 0) return undefined;
  if (typeof hint.content !== "string" || hint.content.length === 0) return undefined;
  return { id: hint.id, content: hint.content, penalty: normalizeHintPenalty(hint.penalty) };
}

function normalizeHintPenalty(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
