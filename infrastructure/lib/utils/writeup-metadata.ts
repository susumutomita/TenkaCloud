/**
 * Issue #2191: spoiler-bearing post-solve explanation projected from problem metadata.
 * JA is canonical; EN is required by the catalog's parity validator.
 */
export interface ProblemWriteup {
  readonly ja: string;
  readonly en: string;
}

/** Decode the synth-bundled writeup map. Invalid input fails closed to no writeups. */
export function parseWriteupsEnv(raw: string | undefined): Record<string, ProblemWriteup> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, ProblemWriteup> = {};
    for (const [problemId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const candidate = value as { ja?: unknown; en?: unknown };
      if (
        typeof candidate.ja === "string" &&
        candidate.ja.trim().length > 0 &&
        typeof candidate.en === "string" &&
        candidate.en.trim().length > 0
      ) {
        result[problemId] = { ja: candidate.ja, en: candidate.en };
      }
    }
    return result;
  } catch {
    return {};
  }
}
