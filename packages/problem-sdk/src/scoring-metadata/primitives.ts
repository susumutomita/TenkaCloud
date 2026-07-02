/**
 * [Problem SDK / Issue #2225 ← #2184 RC-28-6] Shared primitive parsers used across
 * every scoring-metadata kind module. Extracted verbatim from scoring-metadata.ts.
 */

export function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && value > 0;
}

export function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseExpectedStatuses(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const statuses = value.filter((status): status is number => typeof status === "number");
  return statuses.length > 0 ? statuses : undefined;
}
