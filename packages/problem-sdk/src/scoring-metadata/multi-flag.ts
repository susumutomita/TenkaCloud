/**
 * [Problem SDK / Issue #2225 ← #2184 RC-28-6] `multi-flag` scoring kind. Extracted
 * verbatim from scoring-metadata.ts.
 */

import { clampWrongAnswerPenalty, type ProgressiveHint, parseHints } from "./hints.js";
import { optionalNonEmptyString } from "./primitives.js";

/** Issue #1796: one sub-flag of a multi-flag problem. */
export interface MultiFlagEntry {
  readonly id: string;
  readonly label: string;
  readonly flagOutputKey: string;
  readonly points: number;
  readonly wrongAnswerPenalty?: number;
  readonly hints?: readonly ProgressiveHint[];
}

/** Issue #1796: multi-flag kind. N independent flags summing to the problem total. */
export interface MultiFlagScoringMetadata {
  readonly kind: "multi-flag";
  readonly flags: readonly MultiFlagEntry[];
}

/**
 * Issue #1796: narrow the multi-flag kind. Never partial-drop — one invalid entry
 * rejects the whole object (a silently dropped flag would change the problem total
 * per competitor). Duplicate id / flagOutputKey also reject.
 */
export function parseMultiFlag(value: unknown): MultiFlagScoringMetadata | undefined {
  const m = value as { flags?: unknown };
  if (!Array.isArray(m.flags) || m.flags.length === 0) return undefined;

  const flags: MultiFlagEntry[] = [];
  const seenIds = new Set<string>();
  const seenOutputKeys = new Set<string>();
  for (const raw of m.flags) {
    const entry = parseMultiFlagEntry(raw);
    if (!entry) return undefined;
    if (seenIds.has(entry.id) || seenOutputKeys.has(entry.flagOutputKey)) return undefined;
    seenIds.add(entry.id);
    seenOutputKeys.add(entry.flagOutputKey);
    flags.push(entry);
  }
  return { kind: "multi-flag", flags };
}

function parseMultiFlagEntry(value: unknown): MultiFlagEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const e = value as {
    id?: unknown;
    label?: unknown;
    flagOutputKey?: unknown;
    points?: unknown;
    wrongAnswerPenalty?: unknown;
    hints?: unknown;
  };
  const id = optionalNonEmptyString(e.id);
  const label = optionalNonEmptyString(e.label);
  const flagOutputKey = optionalNonEmptyString(e.flagOutputKey);
  if (!id || !label || !flagOutputKey) return undefined;
  if (typeof e.points !== "number" || !Number.isFinite(e.points) || e.points <= 0) return undefined;
  const hints = parseHints(e.hints);
  return {
    id,
    label,
    flagOutputKey,
    points: e.points,
    wrongAnswerPenalty: clampWrongAnswerPenalty(e.wrongAnswerPenalty),
    ...(hints ? { hints } : {}),
  };
}
