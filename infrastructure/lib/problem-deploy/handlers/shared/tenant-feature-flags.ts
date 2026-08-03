import type { FeatureFlagsRepository } from "../../control-data/feature-flags-repository.js";

/**
 * Issue #2231 / #2283 (ADR-035): per-tenant runtime feature-flag 行の共有 reader。
 *
 * 行 shape (`PK: TENANT#<tenantId> / SK: FLAGS`) の書き込み側は
 * event-handler/feature-flags.ts (`PUT /admin/feature-flags`)。 読み側は event-handler に
 * 閉じていたが、 #2283 で participant-handler (challenge access guard) と
 * generic-scoring-handler (Gate 完了 bonus) も同じ判定を必要とするため、 row shape と
 * 読み経路をここへ一本化する (= 「同じ Flag 判定を backend の access guard にも適用する」)。
 *
 * [#2439 / ADR-049 §5.1] 物理 read は {@link FeatureFlagsRepository} seam に委譲する。 この
 * helper は「行 → flag map / 判定」への畳み込みと fail-OFF ポリシーだけを担い、 DynamoDB /
 * Turso いずれの backend でも同じ判定を返す (default backend では従来と byte 互換の GetCommand)。
 */

export function tenantFlagsKey(tenantId: string): { PK: string; SK: "FLAGS" } {
  return { PK: `TENANT#${tenantId}`, SK: "FLAGS" };
}

/**
 * tenant の flag override map を読む。 行が無い (= 一度も保存していない) → `{}`
 * (= 全 flag が registry default)。 DDB error は throw (caller が経路ごとに扱う)。
 */
export async function readTenantFeatureFlags(
  repo: FeatureFlagsRepository,
  tenantId: string,
): Promise<Record<string, boolean>> {
  const record = await repo.get(tenantId);
  return record?.flags ?? {};
}

/**
 * 既定 OFF の flag が tenant で明示 ON かを判定する (enforcement 経路用)。
 *
 * 読み取り失敗は **OFF (= 無効) に倒す**: この flag family は既定 OFF の opt-in 機能
 * (Gate 等) なので、 transient な DDB error で競技操作を誤 block する方が、 1 リクエスト分
 * enforcement を skip するより被害が大きい (scoringLocked の fail-closed とは逆の性質 —
 * あちらは 「lock 中に加点しない」 保証、 こちらは 「既定 OFF 機能で競技を止めない」 保証)。
 */
export async function isTenantFeatureEnabled(
  repo: FeatureFlagsRepository,
  tenantId: string,
  flagKey: string,
): Promise<boolean> {
  try {
    const flags = await readTenantFeatureFlags(repo, tenantId);
    return flags[flagKey] === true;
  } catch (err) {
    console.warn("[tenant-feature-flags] read failed (treating flag as OFF)", {
      tenantId,
      flagKey,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
