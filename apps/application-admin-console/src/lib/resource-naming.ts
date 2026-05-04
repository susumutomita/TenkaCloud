/**
 * 問題 deploy 時の resource 命名規約。
 *
 * 同一 (account, region) に複数チームの問題スタックが同居する運用パターンを許容する
 * (「1 チーム = 1 AWS アカウント」が王道だが、規模を圧縮するためにアカウント
 * 共有でリージョン別 / チーム別に並べることもある)。
 *
 * よって衝突を避けるため、stack 名 + リソース名にチームと問題を埋め込む共通 prefix
 * を導入する。CFn template 側ではこの prefix を `Parameters.NamePrefix` で受け取り、
 * `!Sub '${NamePrefix}-...'` で各リソース名に展開する想定。
 *
 * 規約:
 *   `tc-{problemId-slug}-{teamName-slug}` を base prefix として、
 *   stack 名は `${prefix}` (e.g. `tc-security-battle-royale-alpha-team`)、
 *   個別リソース名は `${prefix}-${role}` (e.g. `${prefix}-vpc`, `${prefix}-ec2`).
 *
 *   Stack 名は CFn 側 128 文字制限。slug + tc + 区切りで余裕を持って ≤ 100 を確保する。
 *   問題 id は 32, team name は 40 までに制限する (form 側 validation)。
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
  const probSlug = slugify(problemId);
  const teamSlug = slugify(teamName);
  return `tc-${probSlug}-${teamSlug}`;
}
