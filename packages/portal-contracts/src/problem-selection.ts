/** Retired teaching material stays loadable for saved events, but cannot be newly selected. */
export function selectableProblem(problem: {
  readonly id: string;
  readonly tags?: readonly string[];
}): boolean {
  return (
    !problem.id.startsWith("ac26-") &&
    !problem.tags?.some(
      (tag) =>
        tag === "cryptography" ||
        tag === "advanced-cryptography" ||
        tag.startsWith("advanced-cryptography-"),
    )
  );
}
