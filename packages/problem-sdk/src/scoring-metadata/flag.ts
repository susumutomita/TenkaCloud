/**
 * [Problem SDK / Issue #2225 ← #2184 RC-28-6] `flag` scoring kind. Extracted
 * verbatim from scoring-metadata.ts.
 */

import {
  clampWrongAnswerPenalty,
  type HintRevealMode,
  type ProgressiveHint,
  parseHintRevealMode,
  parseHints,
} from "./hints.js";

export interface FlagScoringMetadata {
  readonly kind: "flag";
  readonly flagOutputKey: string;
  readonly points: number;
  /** Issue #817: per-wrong-answer penalty (brute-force mitigation). 0 / unset = none. */
  readonly wrongAnswerPenalty?: number;
  readonly hints?: readonly ProgressiveHint[];
  /** Hint unlock order; unset = `sequential` (default). See {@link HintRevealMode}. */
  readonly hintReveal?: HintRevealMode;
}

export function parseFlag(value: unknown): FlagScoringMetadata | undefined {
  const f = value as {
    flagOutputKey?: unknown;
    points?: unknown;
    wrongAnswerPenalty?: unknown;
    hints?: unknown;
    hintReveal?: unknown;
  };
  if (typeof f.flagOutputKey !== "string") return undefined;
  if (typeof f.points !== "number" || !Number.isFinite(f.points) || f.points <= 0) return undefined;
  return {
    kind: "flag",
    flagOutputKey: f.flagOutputKey,
    points: f.points,
    wrongAnswerPenalty: clampWrongAnswerPenalty(f.wrongAnswerPenalty),
    hints: parseHints(f.hints),
    hintReveal: parseHintRevealMode(f.hintReveal),
  };
}
