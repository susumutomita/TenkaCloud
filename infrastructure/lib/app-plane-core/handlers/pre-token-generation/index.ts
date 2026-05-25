import type { PreTokenGenerationTriggerEvent, PreTokenGenerationTriggerHandler } from "aws-lambda";

/**
 * Issue #1327: Lite mode Cognito UserPool 用 Pre-Token Generation trigger。
 *
 * ## なぜ必要か
 * Lite mode (= `tenantId="local"` 1 tenant 専用) では SBT pipeline / `provision-tenant.sh`
 * を経由しないため、 sign-up 直後の Cognito user は `custom:userRole` / `custom:tenantId`
 * 属性が空 (= null) のままになる。 一方 Application Plane handler は SaaS mode と同じ
 * `requireRole(c, [TENANT_ADMIN_ROLE])` で `custom:userRole == "TenantAdmin"` 必須、
 * `resolveTenantId(c)` で `custom:tenantId` を読むため、 Lite mode で sign-in した user は
 * SAML IdP / 監査ログ ページが 403 で開けない (= bug #1327 の症状)。
 *
 * ## 解決
 * Cognito の Pre-Token Generation trigger を Lite mode UserPool に attach し、 id_token /
 * access_token 発行のタイミングで `custom:userRole = "TenantAdmin"` + `custom:tenantId = "local"`
 * を必ず claim に上書きする。 Lite mode は 1 tenant 専用 (= ADR-016 Phase 3) なので、
 * 「全 user は暗黙に TenantAdmin」 という運用前提を JWT claim 層で具現化する。
 *
 * ## SaaS mode との分離
 * SaaS mode の UserPool には本 Lambda を attach しない (= `IdentityProvider` のオプトイン flag
 * `liteAdminClaimsInjection: true` 経由でのみ追加される)。 SaaS の role 割り当ては
 * `provision-tenant.sh` の `admin-create-user` + SBT pipeline 経由なので、 本 Lambda が
 * 暗黙の TenantAdmin 昇格を引き起こすことは無い。
 *
 * ## なぜ event を mutate するだけで済むか
 * Cognito Pre-Token Generation は handler が `event.response.claimsOverrideDetails.claimsToAddOrOverride`
 * を返すと、 JWT 発行直前にその key / value を claim に注入する (= AWS doc: Customizing user
 * pool workflows with Lambda triggers / Pre token generation Lambda trigger)。 IAM / 外部
 * API call は不要。
 *
 * ## 注意 (= overwrite ではなく override)
 * `claimsToAddOrOverride` は既存 claim を **上書き** する仕様 (= 既存 user attribute に
 * `custom:userRole` が別値で設定されていても本 Lambda の値で上書きされる)。 Lite mode は
 * 全員 TenantAdmin / tenantId=local 前提なので intentional な挙動。
 */
export const LITE_TENANT_ADMIN_ROLE = "TenantAdmin" as const;
export const LITE_TENANT_ID = "local" as const;

export const handler: PreTokenGenerationTriggerHandler = async (
  event: PreTokenGenerationTriggerEvent,
) => {
  event.response = {
    claimsOverrideDetails: {
      claimsToAddOrOverride: {
        "custom:userRole": LITE_TENANT_ADMIN_ROLE,
        "custom:tenantId": LITE_TENANT_ID,
      },
    },
  };
  return event;
};
