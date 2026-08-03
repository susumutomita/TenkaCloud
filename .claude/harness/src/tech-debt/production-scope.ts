/**
 * [#2866] tech-debt スキャンの共通 「production コード」 スコープ定義。
 *
 * `high-coupling` と `oversized-file` は同じ path 集合 (production roots のみ、
 * test / generated / dist / cdk.out 除外) を各自で持っていた (= jscpd クローン)。
 * ここに 1 回だけ定義し、 両 rule が import する。
 *
 * 注意: `rules/file-too-large.ts` (architecture harness、 STAGED file gate) の
 * スコープは似ているが `infrastructure/bin/` を含まない別物なので、 ここへは
 * 統合しない — 統合すると gate の検査対象が変わる (= 挙動変更)。
 */

const INCLUDE_PATH_PREFIXES = [
  "infrastructure/lib/",
  "infrastructure/bin/",
  "apps/admin-console/src/",
  "apps/application-admin-console/src/",
  "apps/participant-portal/src/",
  "scripts/",
  "packages/portal-plugin-sdk/src/",
  "packages/trust-bridge/src/",
] as const;

const EXCLUDE_PATTERNS = [
  /\.test\.tsx?$/,
  /\/node_modules\//,
  /\/dist\//,
  /\/cdk\.out\//,
  /\/__generated__\//,
  /\/__mocks__\//,
];

/** production スコープの .ts / .tsx だけ true (test / generated / dist は除外)。 */
export function isProductionSource(path: string): boolean {
  if (!/\.tsx?$/.test(path)) return false;
  if (EXCLUDE_PATTERNS.some((re) => re.test(path))) return false;
  return INCLUDE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}
