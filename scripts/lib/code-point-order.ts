/**
 * Locale-independent string ordering — the same order `Array#sort()` uses with no comparator,
 * written out so the choice is visible instead of implied.
 *
 * `sonarjs/no-alphabetical-sort` (S2871) flags every bare `.sort()` and its suggested fix is
 * `localeCompare`, which is the wrong answer for every call site in `scripts/`: these sorts feed
 * an AWS SigV4 `SignedHeaders` list, a checked-in baseline JSON, and ISO-8601 timestamp
 * comparison. All three need byte order that is identical on every machine — `localeCompare`
 * is locale- and ICU-version-dependent and can reorder or ignore punctuation such as `-` / `:`.
 */
export function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
