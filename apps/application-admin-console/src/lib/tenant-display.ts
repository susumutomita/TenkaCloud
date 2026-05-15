import type { IdTokenClaims } from "../auth/claims";

/**
 * Issue #830: JWT id_token から Home ヘッダ用の display name を解決する。
 *
 * 旧 logic は `tenantName ?? tenantId ?? "(unknown tenant)"` で、 `custom:tenantName`
 * が無いと `custom:tenantId` (= SBT が生成する UUID v4) が welcome 文に露出して
 * 「ようこそ、3f01a734-9652-4065-... さん」 のような UX 事故になっていた。
 *
 * 本 helper は **welcome 文に UUID を出さない** ことを保証する:
 *   - tenantName があれば そのまま返す
 *   - tenantName が空 / 未設定なら fallback (= caller が i18n 化する placeholder) を
 *     使うことを `fromFallback: true` で伝える
 *
 * tenantId 自体は 「テナント情報」 panel で別途表示するので、 welcome 文側で重複
 * 表示する必要はない (= panel に raw 値があれば operator は識別できる)。
 */
export function resolveTenantDisplayName(claims: IdTokenClaims | null): {
  readonly displayName: string | null;
  readonly fromFallback: boolean;
} {
  const tenantName = claims?.["custom:tenantName"]?.trim();
  if (tenantName && tenantName.length > 0) {
    return { displayName: tenantName, fromFallback: false };
  }
  return { displayName: null, fromFallback: true };
}
