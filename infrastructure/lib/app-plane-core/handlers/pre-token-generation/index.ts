import type {
  PreTokenGenerationV2TriggerEvent,
  PreTokenGenerationV2TriggerHandler,
} from "aws-lambda";

/**
 * Issue #1327 / #1358: Lite mode Cognito UserPool 用 Pre-Token Generation V2 trigger。
 *
 * ## なぜ必要か
 * Lite mode (= `tenantId="local"` 1 tenant 専用) では SBT pipeline / `provision-tenant.sh`
 * を経由しないため、 self sign-up 直後の Cognito user は `custom:tenantId` / `custom:tenantName`
 * 属性が空のままになる。 一方 Application Plane handler は SaaS mode と同じ
 * `requireRole(c, [TENANT_ADMIN_ROLE])` で `custom:userRole` を、 `resolveTenantId(c)` で
 * `custom:tenantId` を ID token から読むため、 これらが無いと 403 / tenant 不明になる。
 *
 * ## V2 trigger を採用する理由 (#1358)
 * V1 trigger は **access token** にしか claim を inject できない。 Application Plane handler は
 * Cognito JWT authorizer 経由で **ID token** を読むため、 V2 trigger
 * (`claimsAndScopeOverrideDetails.idTokenGeneration.claimsToAddOrOverride`) で ID token /
 * access token の双方に inject する。
 *
 * ## role は user の割り当てを尊重する (= 招待ロールの enforcement)
 * 当初は 「Lite = 全員 TenantAdmin」 として `custom:userRole` を一律 TenantAdmin に上書き
 * していたが、 Users ページ (`POST /admin/users`) で TenantOperator / TenantViewer を招待
 * できるようになった以上、 token がロールを無視すると **Viewer が Admin 操作を実行できてしまう**
 * (= broken access control)。 そこで:
 *
 *   - user attribute `custom:userRole` が有効な tenant role なら **その値をそのまま** claim にする
 *     (= 招待時 / role 変更時に `AdminCreateUser` / `AdminUpdateUserAttributes` が set した値)。
 *   - 属性が未設定の user (= self sign-up した最初の主催者) は `TenantAdmin` に fallback する。
 *     こうすることで最初の運営者が締め出されず、 招待された Operator / Viewer は正しく制限される。
 *
 * `custom:tenantId` は Lite が 1 tenant 固定なので常に `local` を注入する。
 * `custom:tenantName` も属性が無ければ `LITE_TENANT_NAME` を注入する (= Home の
 * 「テナント名が JWT に含まれていません」 警告を解消する)。
 *
 * ## SaaS mode との分離
 * SaaS mode の UserPool には本 Lambda を attach しない (= `liteAdminClaimsInjection: true`
 * opt-in flag 経由でのみ追加)。 SaaS の role 割り当ては `provision-tenant.sh` + SBT pipeline
 * 経由なので、 本 Lambda が暗黙の昇格を引き起こすことは無い。
 */
export const LITE_TENANT_ADMIN_ROLE = "TenantAdmin" as const;
export const LITE_TENANT_ID = "local" as const;
export const LITE_TENANT_NAME = "TenkaCloud Lite" as const;

/** `custom:userRole` claim に入る有効値 (= deploy-handler/auth.ts の TENANT_ROLES と一致)。 */
const LITE_TENANT_ROLES = ["TenantAdmin", "TenantOperator", "TenantViewer"] as const;

/**
 * user attribute の `custom:userRole` が有効な tenant role ならそれを、 無ければ
 * `TenantAdmin` (= bootstrap 主催者の締め出し防止) を返す。
 */
function resolveUserRole(attrs: Readonly<Record<string, string>>): string {
  const raw = attrs["custom:userRole"];
  return typeof raw === "string" && (LITE_TENANT_ROLES as readonly string[]).includes(raw)
    ? raw
    : LITE_TENANT_ADMIN_ROLE;
}

/** user attribute の `custom:tenantName` があればそれを、 無ければ既定の Lite tenant 名を返す。 */
function resolveTenantName(attrs: Readonly<Record<string, string>>): string {
  const raw = attrs["custom:tenantName"];
  return typeof raw === "string" && raw.trim().length > 0 ? raw : LITE_TENANT_NAME;
}

export const handler: PreTokenGenerationV2TriggerHandler = async (
  event: PreTokenGenerationV2TriggerEvent,
) => {
  const attrs = event.request.userAttributes ?? {};
  const claimsToAddOrOverride = {
    "custom:userRole": resolveUserRole(attrs),
    "custom:tenantId": LITE_TENANT_ID,
    "custom:tenantName": resolveTenantName(attrs),
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
