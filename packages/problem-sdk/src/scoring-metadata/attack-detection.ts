/**
 * [Problem SDK / Issue #2225 ← #2184 RC-28-6] `attack-detection` scoring kind.
 * Extracted verbatim from scoring-metadata.ts.
 */

import { type ProgressiveHint, parseHints } from "./hints.js";

export interface AttackDetectionCategory {
  readonly name: string;
  readonly pointsPerAttack?: number;
}

export interface AttackDetectionScoringMetadata {
  readonly kind: "attack-detection";
  readonly statsOutputKey: string;
  readonly pointsPerAttack: number;
  readonly categories?: readonly AttackDetectionCategory[];
  readonly hints?: readonly ProgressiveHint[];
}

export function parseAttackDetection(value: unknown): AttackDetectionScoringMetadata | undefined {
  const a = value as {
    statsOutputKey?: unknown;
    pointsPerAttack?: unknown;
    categories?: unknown;
    hints?: unknown;
  };
  if (typeof a.statsOutputKey !== "string" || a.statsOutputKey.length === 0) return undefined;
  if (typeof a.pointsPerAttack !== "number" || a.pointsPerAttack <= 0) return undefined;
  const categories = parseAttackDetectionCategories(a.categories);
  const hints = parseHints(a.hints);
  return {
    kind: "attack-detection",
    statsOutputKey: a.statsOutputKey,
    pointsPerAttack: a.pointsPerAttack,
    ...(categories.length > 0 ? { categories } : {}),
    ...(hints ? { hints } : {}),
  };
}

function parseAttackDetectionCategories(value: unknown): AttackDetectionCategory[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const category = entry as { name?: unknown; pointsPerAttack?: unknown };
      if (typeof category.name !== "string") return undefined;
      return {
        name: category.name,
        ...(typeof category.pointsPerAttack === "number"
          ? { pointsPerAttack: category.pointsPerAttack }
          : {}),
      };
    })
    .filter((category): category is AttackDetectionCategory => category !== undefined);
}
