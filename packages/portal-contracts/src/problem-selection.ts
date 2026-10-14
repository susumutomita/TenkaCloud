// Legacy SHA-256 lessons predate the shared cryptography tags.
const retiredLegacyIds = new Set([
  "sha256-bytes-padding",
  "sha256-compress-digest",
  "sha256-schedule-logic",
]);

/** Retired teaching material stays loadable for saved events, but cannot be newly selected. */
export function selectableProblem(problem: {
  readonly id: string;
  readonly tags?: readonly string[];
}): boolean {
  return (
    !retiredLegacyIds.has(problem.id) &&
    !problem.id.startsWith("ac26-") &&
    !problem.tags?.some(
      (tag) =>
        tag === "cryptography" ||
        tag === "advanced-cryptography" ||
        tag.startsWith("advanced-cryptography-"),
    )
  );
}
