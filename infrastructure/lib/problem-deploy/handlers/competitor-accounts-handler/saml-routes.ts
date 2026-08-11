import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { extractClaims, resolveCognitoSub, resolveTenantId } from "../deploy-handler/auth.js";
import {
  allowCognitoOnClient,
  type CognitoSamlDeps,
  deleteSamlProvider,
  enforceSamlOnlyOnClient,
  extractUserPoolIdFromIss,
  upsertSamlProvider,
} from "./cognito-saml.js";
import { deleteTenantSamlConfig, getTenantSamlConfig, putTenantSamlConfig } from "./saml-store.js";
import {
  DEFAULT_SAML_PROVIDER_NAME,
  normalizeAttributeMapping,
  type TenantSamlConfigInput,
  TenantSamlConfigInputSchema,
  type TenantSamlConfigView,
} from "./saml-types.js";
import type { CompetitorAccountsSharedResources } from "./shared.js";

/**
 * Issue #839 follow-up Phase B: Tenant 管理者が画面 / API から SAML IdP を CRUD する route 群。
 *
 *   GET    /admin/tenant-saml-config       — 現在の設定 view (= disabled なら enabled:false)
 *   PUT    /admin/tenant-saml-config       — upsert (= Cognito IdP create/update + UserPoolClient
 *                                            mutation + DDB persist)
 *   DELETE /admin/tenant-saml-config       — disable (= UserPoolClient から SAML を外し + COGNITO
 *                                            復元 → IdP 削除 → DDB row 削除)
 *
 * 設計判断:
 *  - **UserPool ID は JWT iss から runtime 抽出**: cross-stack で具体 UserPool ARN を渡さず、
 *    呼び出した user の token issuer の UserPool だけを mutate する self-targeting にする。
 *  - **UserPoolClient ID は JWT aud (= client_id) から抽出**: UserPool 内に複数 client がある
 *    ケースを想定せず、 token が来た client を対象にする。
 *  - **enforceSamlOnly: true への flip は破壊的**: caller (UI) は 2-step 確認 modal を要求する。
 *    backend は単純に flag を見て enforce する (= 確認 UX は frontend 責任)。
 *  - **lock-out からの復旧経路**: 万一 SAML 設定が壊れて誰もログインできなくなったら、 operator は
 *    `make deploy` で CDK 経由に戻すか、 AWS Console から手動で UserPoolClient.SupportedIdentityProviders
 *    に COGNITO を足す。 これは security ops doc に残す前提。
 */

/** Zod の validation issue を body に出す共通 error shape。 */
interface ValidationFailedBody {
  readonly error: "validation_failed";
  readonly issues: unknown;
}

/**
 * SAML route の結果型。 `status` を discriminant にした union にすることで、 caller (index.ts)
 * が `c.json(result.body, result.status)` を unsafe cast 無しで型検査できる (= body 形と status の
 * 対応が型で固定される)。 各 status の body 形は実 runtime レスポンスと 1:1 で一致させる
 * (= behavior-preserving)。
 */
export type SamlRouteResult =
  | { readonly status: StatusCodes.OK; readonly body: TenantSamlConfigView }
  | { readonly status: StatusCodes.OK; readonly body: { readonly deleted: true } }
  | { readonly status: StatusCodes.BAD_REQUEST; readonly body: ValidationFailedBody }
  | { readonly status: StatusCodes.BAD_REQUEST; readonly body: { readonly error: "invalid_body" } }
  | {
      readonly status: StatusCodes.UNPROCESSABLE_ENTITY;
      readonly body: { readonly error: "missing_cognito_claims"; readonly message: string };
    }
  | {
      readonly status: StatusCodes.SERVICE_UNAVAILABLE;
      readonly body: { readonly error: "tenant_tier_not_silo"; readonly message: string };
    };

interface JwtClaims {
  readonly iss?: string;
  readonly aud?: string;
  readonly client_id?: string;
  readonly sub?: string;
  readonly [k: string]: unknown;
}

/**
 * JWT claims から Cognito self-targeting に必要な情報を取り出す。 必要な claim が無ければ
 * `undefined` を返し、 caller が 401 / 422 に倒す。
 */
export function extractSelfPoolFromContext(c: Context): CognitoSamlDeps | undefined {
  const claims = extractClaims(c) as JwtClaims | undefined;
  const userPoolId = extractUserPoolIdFromIss(claims?.iss);
  // Cognito access_token は aud ではなく client_id を持つ場合がある (= access_token vs id_token)。
  // API GW JWT Authorizer は id_token を要求するので aud を優先しつつ、 client_id fallback も持つ。
  const userPoolClientId =
    typeof claims?.aud === "string" && claims.aud.length > 0
      ? claims.aud
      : typeof claims?.client_id === "string" && claims.client_id.length > 0
        ? claims.client_id
        : undefined;
  if (!userPoolId || !userPoolClientId) return undefined;
  return {
    client: { send: () => Promise.reject(new Error("client not injected")) },
    userPoolId,
    userPoolClientId,
  };
}

/**
 * GET の DDB 経由実装。 caller の Hono ルートから呼ばれる pure-ish function (= shared + tenantId のみ依存)。
 */
export async function handleGetTenantSamlConfig(
  shared: CompetitorAccountsSharedResources,
  tenantId: string,
): Promise<SamlRouteResult> {
  const view = await getTenantSamlConfig(
    { runtime: shared.runtime, ddb: shared.ddb, tableName: shared.tableName },
    tenantId,
  );
  if (!view) {
    const disabled: TenantSamlConfigView = { enabled: false };
    return { status: StatusCodes.OK, body: disabled };
  }
  return { status: StatusCodes.OK, body: view };
}

/**
 * PUT 本体。 validation → Cognito upsert → UserPoolClient mutate → DDB persist の順。
 * 失敗時の rollback は半端 (= DDB だけ書いて Cognito 失敗、 など) になり得るが、 再送で必ず
 * eventual consistency に倒れる (= idempotent) ことで許容する。
 */
export async function handlePutTenantSamlConfig(
  shared: CompetitorAccountsSharedResources,
  cognitoDeps: CognitoSamlDeps,
  ctx: { readonly tenantId: string; readonly updatedBy: string; readonly nowIso: string },
  rawBody: unknown,
): Promise<SamlRouteResult> {
  const parsed = TenantSamlConfigInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return {
      status: StatusCodes.BAD_REQUEST,
      body: { error: "validation_failed", issues: parsed.error.issues },
    };
  }
  const input: TenantSamlConfigInput = parsed.data;
  const providerName = input.providerName ?? DEFAULT_SAML_PROVIDER_NAME;
  const attributeMapping = normalizeAttributeMapping(input.attributeMapping);

  // 1. Cognito IdP を upsert (= 既存なら Update、 無ければ Create)。
  await upsertSamlProvider(cognitoDeps, {
    providerName,
    metadataUrl: input.metadataUrl,
    attributeMapping,
  });

  // 2. UserPoolClient.SupportedIdentityProviders と ExplicitAuthFlows を flip。
  if (input.enforceSamlOnly === true) {
    await enforceSamlOnlyOnClient(cognitoDeps, providerName);
  } else {
    // 並列許可 (= COGNITO 経路は維持)。 SAML を SupportedIdentityProviders に追加。
    // helper の名前が "allow" + "attach" で動詞 split されているため、 順序は:
    //   - 先に COGNITO を残しつつ SAML を追加 (= attach)
    //   - allowCognitoOnClient は逆方向 (= SAML を外す経路) なので使わない
    const { attachSamlToClient } = await import("./cognito-saml.js");
    await attachSamlToClient(cognitoDeps, providerName);
  }

  // 3. DDB persist (= UI が次回 GET で current state を見れる)。
  const view = await putTenantSamlConfig(
    { runtime: shared.runtime, ddb: shared.ddb, tableName: shared.tableName },
    ctx.tenantId,
    { ...input, providerName, attributeMapping },
    { updatedAt: ctx.nowIso, updatedBy: ctx.updatedBy },
  );

  // 4. 監査ログ (= console.log 経路、 ZERO 新 infra)。
  console.log(
    JSON.stringify({
      event: "tenant-saml.upsert",
      tenantId: ctx.tenantId,
      providerName,
      enforceSamlOnly: input.enforceSamlOnly === true,
      updatedBy: ctx.updatedBy,
      updatedAt: ctx.nowIso,
    }),
  );

  return { status: StatusCodes.OK, body: view };
}

/**
 * DELETE 本体。 idempotent: 不在の SAML config を消しても OK。
 *
 * 順序:
 *   1. UserPoolClient から SAML を外し COGNITO を必ず復元 (= lock-out 防止)
 *   2. Cognito IdP を削除 (= 残ったままだと UserPool 内で provider name 衝突するため)
 *   3. DDB row 削除
 *
 * 1 と 2 の間で Lambda が落ちると IdP だけ残る (= UserPoolClient 側では参照外れているので
 * 実害なし、 次回 PUT で同 provider name の Update を打てる)。 caller の再送で eventual consistency。
 */
export async function handleDeleteTenantSamlConfig(
  shared: CompetitorAccountsSharedResources,
  cognitoDeps: CognitoSamlDeps,
  ctx: { readonly tenantId: string; readonly updatedBy: string; readonly nowIso: string },
): Promise<SamlRouteResult> {
  // 既存 config を読んで providerName を決める。 無ければ default 名で attempt (= 不在なら no-op)。
  const existing = await getTenantSamlConfig(
    { runtime: shared.runtime, ddb: shared.ddb, tableName: shared.tableName },
    ctx.tenantId,
  );
  const providerName = existing?.providerName ?? DEFAULT_SAML_PROVIDER_NAME;

  // 1. UserPoolClient revert: SAML を外し COGNITO + 標準 ExplicitAuthFlows を復元。
  await allowCognitoOnClient(cognitoDeps, providerName);

  // 2. Cognito IdP delete (idempotent)。
  await deleteSamlProvider(cognitoDeps, providerName);

  // 3. DDB row 削除。
  await deleteTenantSamlConfig(
    { runtime: shared.runtime, ddb: shared.ddb, tableName: shared.tableName },
    ctx.tenantId,
  );

  console.log(
    JSON.stringify({
      event: "tenant-saml.delete",
      tenantId: ctx.tenantId,
      providerName,
      deletedBy: ctx.updatedBy,
      deletedAt: ctx.nowIso,
    }),
  );

  return { status: StatusCodes.OK, body: { deleted: true } };
}

/**
 * Hono route handlers から呼ぶ thin orchestration: tenantId + sub を context から取り、
 * Cognito self-targeting deps を組んで、 route-specific handler を呼ぶ。
 *
 * 各 route handler は **pure-ish** (= ctx 引数のみ取る) なので test しやすい。
 */
export interface SamlOrchestratorDeps {
  readonly shared: CompetitorAccountsSharedResources;
  /** test injection 用: Cognito SDK の動的 client。 prod では `shared.cognito` がそのまま入る。 */
  readonly makeCognitoDeps?: (
    c: Context,
  ) => Promise<CognitoSamlDeps | undefined> | CognitoSamlDeps | undefined;
}

export function defaultMakeCognitoDeps(
  shared: CompetitorAccountsSharedResources,
): (c: Context) => CognitoSamlDeps | undefined {
  return (c) => {
    const skeleton = extractSelfPoolFromContext(c);
    if (!skeleton) return undefined;
    return {
      client: shared.cognito,
      userPoolId: skeleton.userPoolId,
      userPoolClientId: skeleton.userPoolClientId,
    };
  };
}

// #1385: pooled tier は UserPool + UserPoolClient を全 pooled tenant で共有する。
// そこで SAML config を mutate (= UserPoolClient の SupportedIdentityProviders /
// ExplicitAuthFlows 書き換え) すると他 pooled tenant のログインを巻き込む (cross-tenant DoS /
// 認証ハイジャック)。 専有 UserPool を持つ silo (PLATINUM) / Lite mode のみ mutation を許可する。
// `custom:tenantTier` は provision 時に server-set され、 API GW JWT authorizer が署名検証するため
// 詐称不能。 claim 不在 (= silo / Lite / admin 経路) は許可側に倒す (pooled は必ず tier claim を持つ)。
//
// fail-closed: 旧実装の pooled deny-list ({BASIC, STANDARD, PREMIUM}) は tier リネーム
// (#55 premium→platinum、 製品 tier は basic/advanced/platinum) で ADVANCED を取りこぼし、
// pooled tenant が共有 UserPool を mutate できた。 「claim があり SILO_TIER 以外は全て block」
// に反転し、 将来の tier 追加 / リネームでもガードが開かないようにする。
const SILO_TIER = "PLATINUM";

export function pooledTierSamlBlock(c: Context): SamlRouteResult | undefined {
  const claims = extractClaims(c) as JwtClaims | undefined;
  const raw = claims?.["custom:tenantTier"];
  const tier = typeof raw === "string" ? raw.trim().toUpperCase() : undefined;
  if (tier && tier !== SILO_TIER) {
    return {
      status: StatusCodes.SERVICE_UNAVAILABLE,
      body: {
        error: "tenant_tier_not_silo",
        message:
          "SAML SSO configuration requires a dedicated UserPool (PLATINUM tier). Pooled tiers share a UserPool and cannot enable SAML.",
      },
    };
  }
  return undefined;
}

export async function routeGet(deps: SamlOrchestratorDeps, c: Context): Promise<SamlRouteResult> {
  const tenantId = resolveTenantId(c);
  return handleGetTenantSamlConfig(deps.shared, tenantId);
}

export async function routePut(deps: SamlOrchestratorDeps, c: Context): Promise<SamlRouteResult> {
  const tierBlock = pooledTierSamlBlock(c);
  if (tierBlock) return tierBlock;
  const tenantId = resolveTenantId(c);
  const sub = resolveCognitoSub(c);
  const cognitoDeps = await (deps.makeCognitoDeps?.(c) ?? defaultMakeCognitoDeps(deps.shared)(c));
  if (!cognitoDeps) {
    return {
      status: StatusCodes.UNPROCESSABLE_ENTITY,
      body: { error: "missing_cognito_claims", message: "iss / aud claims are required" },
    };
  }
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return { status: StatusCodes.BAD_REQUEST, body: { error: "invalid_body" } };
  }
  return handlePutTenantSamlConfig(
    deps.shared,
    cognitoDeps,
    {
      tenantId,
      updatedBy: sub,
      nowIso: new Date().toISOString(),
    },
    body,
  );
}

export async function routeDelete(
  deps: SamlOrchestratorDeps,
  c: Context,
): Promise<SamlRouteResult> {
  const tierBlock = pooledTierSamlBlock(c);
  if (tierBlock) return tierBlock;
  const tenantId = resolveTenantId(c);
  const sub = resolveCognitoSub(c);
  const cognitoDeps = await (deps.makeCognitoDeps?.(c) ?? defaultMakeCognitoDeps(deps.shared)(c));
  if (!cognitoDeps) {
    return {
      status: StatusCodes.UNPROCESSABLE_ENTITY,
      body: { error: "missing_cognito_claims", message: "iss / aud claims are required" },
    };
  }
  return handleDeleteTenantSamlConfig(deps.shared, cognitoDeps, {
    tenantId,
    updatedBy: sub,
    nowIso: new Date().toISOString(),
  });
}
