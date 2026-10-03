import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Context } from "hono";
import type { DeploymentsQueryPort } from "../../control-data/deployments-repository.js";
import type { ControlDataRuntime } from "../../control-data/runtime-repositories.js";
import { extractClaims } from "./auth.js";
import { resolveDeploymentsRepository } from "./shared.js";

/**
 * Issue #1766: tier 別の同時デプロイクォータ。
 *
 * tier はこれまで PLATINUM の IdP ガード (tier-guard.ts) と provisioning 分岐にしか効いて
 * おらず、pooled tenant が無制限に問題デプロイできた。deploy 受付時に tenant tier
 * (= JWT `custom:tenantTier`、provision 時に server-set + API GW 署名検証済で詐称不能)
 * を見て、アクティブな deployment 数が上限に達していたら 429 で弾く。
 *
 * - 上限値は config (`deployQuotaByTier`) で宣言し、Lambda には `DEPLOY_QUOTA_BY_TIER`
 *   env (JSON) で渡す。env 未設定 = クォータ無効 (在来 stack / Lite mode の後方互換)。
 * - tier claim 不在 / 未知値は **最も厳しい basic の上限に倒す** (fail-closed。
 *   saml-routes の tier deny-list が ADVANCED を取りこぼした regression を踏まえ、
 *   未知 tier を無制限側に倒さない)。
 * - count→write の間に並行 request が滑り込む TOCTOU は許容する (= クォータは課金保護の
 *   近似制御であり、厳密な直列化に DDB TransactWrite を費やすコストに見合わない)。
 */

export interface DeployQuotaConfig {
  readonly basic: number;
  readonly advanced: number;
  readonly platinum: number;
}

export type QuotaTier = keyof DeployQuotaConfig;

/**
 * 同時デプロイ数にカウントするアクティブ status。終端 (FAILED/DELETED/EXPIRED 系) は対象外。
 * Issue #2019: APPROVAL_PENDING (= enforcement で保留中) も枠を予約済とみなし計上する
 * (= 保留行を量産して quota を迂回されるのを防ぐ)。
 */
const ACTIVE_STATUSES = [
  "PENDING",
  "APPROVAL_PENDING",
  "IN_PROGRESS",
  "COMPLETE",
  "DELETING",
] as const;

export class DeployQuotaExceededError extends Error {
  constructor(
    readonly tier: QuotaTier,
    readonly limit: number,
    readonly active: number,
  ) {
    super(
      `deploy quota exceeded for tier ${tier}: ${active} active deployment(s) >= limit ${limit}`,
    );
    this.name = "DeployQuotaExceededError";
  }
}

/**
 * `DEPLOY_QUOTA_BY_TIER` env (JSON: {"basic":N,"advanced":N,"platinum":N}) を parse する。
 * 未設定 / 空文字は「クォータ無効」で undefined。設定されているのに壊れている場合は
 * loud に throw する (= silent に無効化して課金保護が消えるのを防ぐ)。
 */
export function parseDeployQuota(raw: string | undefined): DeployQuotaConfig | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`DEPLOY_QUOTA_BY_TIER is not valid JSON: ${raw}`);
  }
  // JSON.parse("null") / 配列 / 文字列等は後続の index アクセスで生 TypeError になり
  // 意図した設定エラーメッセージを迂回するため、object 以外をここで明示拒否する。
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`DEPLOY_QUOTA_BY_TIER must be a JSON object, got: ${raw}`);
  }
  const obj = parsed as Partial<Record<QuotaTier, unknown>>;
  for (const tier of ["basic", "advanced", "platinum"] as const) {
    const v = obj[tier];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new Error(
        `DEPLOY_QUOTA_BY_TIER.${tier} must be a non-negative integer, got: ${String(v)}`,
      );
    }
  }
  return obj as DeployQuotaConfig;
}

/**
 * JWT claims から quota tier を解決する。claim 不在 / 未知値は basic (最も厳しい上限)。
 */
export function resolveQuotaTier(c: Context): QuotaTier {
  const raw = extractClaims(c)?.["custom:tenantTier"];
  const tier = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (tier === "advanced" || tier === "platinum") return tier;
  return "basic";
}

export interface DeployQuotaDeps {
  /** [#2527 Slice 4] Injected control-data runtime (from the Lambda entrypoint's instance). */
  readonly runtime: ControlDataRuntime;
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly tableName: string;
  readonly quota: DeployQuotaConfig | undefined;
}

/**
 * tenant のアクティブ deployment 数を数え、上限到達なら `DeployQuotaExceededError` を投げる。
 * quota 未設定 (env 未配線) は no-op。
 */
export async function enforceDeployQuota(
  deps: DeployQuotaDeps,
  tenantId: string,
  tier: QuotaTier,
): Promise<void> {
  if (!deps.quota) return;
  const limit = deps.quota[tier];
  const repository: DeploymentsQueryPort = await resolveDeploymentsRepository(deps);
  const active = await repository.countActiveByTenant(tenantId, ACTIVE_STATUSES, {
    stopAtCount: limit,
  });
  if (active >= limit) {
    throw new DeployQuotaExceededError(tier, limit, active);
  }
}
