/**
 * UI 側 (apps/application-admin-console/src/lib/resource-naming.ts) と同じ命名規約。
 * 同一 (Account, Region) に複数チームのスタックが共存できるよう `tc-{problemSlug}-{teamSlug}`
 * を全リソースの prefix に使う。frontend と backend で計算結果を一致させるため、
 * ここに同じ実装を置く (将来 packages/ に統一)。
 */
const SLUG_NON_ALPHANUM = /[^A-Za-z0-9]+/g;

function trimBoundaryDashes(input: string): string {
  let start = 0;
  while (input[start] === "-") start += 1;

  let end = input.length;
  while (end > start && input[end - 1] === "-") end -= 1;

  return input.slice(start, end);
}

export function slugify(input: string): string {
  const sanitized = input.toLowerCase().replace(SLUG_NON_ALPHANUM, "-");
  return trimBoundaryDashes(sanitized).slice(0, 40);
}

export function buildStackPrefix(problemId: string, teamName: string): string {
  return `tc-${slugify(problemId)}-${slugify(teamName)}`;
}
