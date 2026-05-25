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

/**
 * Issue #1314: 競技者 IAM Role 名は **Application Plane (= tenantId) ごとに unique** に
 * 生成する。 同一 AWS account が 別 Plane / 別 event に並列参加するとき、 固定名
 * `TenkaCloud-CompetitorDeploy-Role` を再利用すると CFn create-stack が
 * `AlreadyExistsException` で fail するため、 Plane scope の namespace を含める。
 *
 *   TenkaCloud-{tenantId}-{namespace}-Role
 *
 * IAM Role 名 charclass (`[A-Za-z0-9_+=,.@-]{1,64}`) は CFn `competitor-bootstrap.yaml` の
 * `AllowedPattern` と一致。 backend (`infrastructure/lib/problem-deploy/handlers/shared/events.ts`)
 * の `defaultCompetitorRoleName` と同じロジック (= 1 場所に集約せず重複している理由は、
 * SPA bundle が Lambda code を import すると node 専用 dep が芋づる的に入るため)。
 */
const IAM_ROLE_SANITIZE_RE = /[^A-Za-z0-9_+=,.@-]+/g;
const IAM_ROLE_MAX_LENGTH = 64;

function sanitizeRoleSegment(segment: string): string {
  return segment.replace(IAM_ROLE_SANITIZE_RE, "-").replace(/^-+|-+$/g, "");
}

export function defaultCompetitorRoleName(opts: { tenantId: string; namespace?: string }): string {
  const tenant = sanitizeRoleSegment(opts.tenantId) || "tenant";
  const ns = sanitizeRoleSegment(opts.namespace ?? "deploy") || "deploy";
  const candidate = `TenkaCloud-${tenant}-${ns}-Role`;
  if (candidate.length <= IAM_ROLE_MAX_LENGTH) return candidate;
  const suffix = `-${ns}-Role`;
  const prefix = "TenkaCloud-";
  const room = IAM_ROLE_MAX_LENGTH - prefix.length - suffix.length;
  const truncated = tenant.slice(0, Math.max(1, room));
  return `${prefix}${truncated}${suffix}`;
}
