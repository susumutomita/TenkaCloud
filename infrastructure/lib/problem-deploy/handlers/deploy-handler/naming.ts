/**
 * UI 側 (apps/application-admin-console/src/lib/resource-naming.ts) と同じ命名規約。
 * 同一 (Account, Region) に複数チームのスタックが共存できるよう `tc-{problemSlug}-{teamSlug}`
 * を全リソースの prefix に使う。frontend と backend で計算結果を一致させるため、
 * ここに同じ実装を置く (将来 packages/ に統一)。
 */
const SLUG_NON_ALPHANUM = /[^A-Za-z0-9]+/g;
const SLUG_TRIM_DASH = /^-+|-+$/g;

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(SLUG_NON_ALPHANUM, "-")
    .replace(SLUG_TRIM_DASH, "")
    .slice(0, 40);
}

export function buildStackPrefix(problemId: string, teamName: string): string {
  return `tc-${slugify(problemId)}-${slugify(teamName)}`;
}
