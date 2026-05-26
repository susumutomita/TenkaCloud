import type {
  PreTokenGenerationV2TriggerEvent,
  PreTokenGenerationV2TriggerHandler,
} from "aws-lambda";

/**
 * Issue #1327 / #1358: Lite mode Cognito UserPool 用 Pre-Token Generation V2 trigger。
 *
 * ## なぜ必要か
 * Lite mode (= `tenantId="local"` 1 tenant 専用) では SBT pipeline / `provision-tenant.sh`
 * を経由しないため、 sign-up 直後の Cognito user は `custom:userRole` / `custom:tenantId`
 * 属性が空 (= null) のままになる。 一方 Application Plane handler は SaaS mode と同じ
 * `requireRole(c, [TENANT_ADMIN_ROLE])` で `custom:userRole == "TenantAdmin"` 必須、
 * `resolveTenantId(c)` で `custom:tenantId` を読むため、 Lite mode で sign-in した user は
 * SAML IdP / 監査ログ ページが 403 で開けない (= bug #1327 の症状)。
 *
 * ## V2 trigger を採用する理由 (#1358)
 * V1 trigger response (`response.claimsOverrideDetails.claimsToAddOrOverride`) は **access token**
 * 側にしか claim を inject しない。 一方 Application Plane の handler は Cognito JWT
 * authorizer 経由で **ID token** を読むため (= `requireRole` / `resolveTenantId` が claim を
 * 取り出す source が ID token)、 V1 形式だと claim が乗らず 403 が解消しない。
 *
 * V2 trigger response (`claimsAndScopeOverrideDetails.idTokenGeneration.claimsToAddOrOverride`)
 * は ID token と access token の双方に inject 可能。 両方に同値を入れることで API Gateway /
 * Lambda authorizer / SDK 側の token 種類選好に依らず一貫した claim を提供する。
 *
 * ## 解決
 * Cognito の Pre-Token Generation V2 trigger を Lite mode UserPool に attach し、 id_token /
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
 * Cognito Pre-Token Generation は handler が `event.response.claimsAndScopeOverrideDetails`
 * を返すと、 JWT 発行直前にその key / value を id_token / access_token の claim に注入する
 * (= AWS doc: Customizing user pool workflows with Lambda triggers / Pre token generation
 * Lambda trigger / V2 trigger event)。 IAM / 外部 API call は不要。
 *
 * ## 注意 (= overwrite ではなく override)
 * `claimsToAddOrOverride` は既存 claim を **上書き** する仕様 (= 既存 user attribute に
 * `custom:userRole` が別値で設定されていても本 Lambda の値で上書きされる)。 Lite mode は
 * 全員 TenantAdmin / tenantId=local 前提なので intentional な挙動。
 */
export const LITE_TENANT_ADMIN_ROLE = "TenantAdmin" as const;
export const LITE_TENANT_ID = "local" as const;

export const handler: PreTokenGenerationV2TriggerHandler = async (
  event: PreTokenGenerationV2TriggerEvent,
) => {
  const claimsToAddOrOverride = {
    "custom:userRole": LITE_TENANT_ADMIN_ROLE,
    "custom:tenantId": LITE_TENANT_ID,
  } as const;

  event.response = {
    claimsAndScopeOverrideDetails: {
      idTokenGeneration: {
        claimsToAddOrOverride,
      },
      accessTokenGeneration: {
        claimsToAddOrOverride,
      },
      // group override は使わない (= UserPool group 経路を Lite では使わない)。 ただし
      // V2 contract 上 `groupOverrideDetails: {}` を明示的に空オブジェクトで返すことで
      // 「未指定 = 既存 group を尊重」 を意図として固定する。
      groupOverrideDetails: {},
    },
  };
  return event;
};
