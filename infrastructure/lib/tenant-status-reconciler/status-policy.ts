/**
 * Issue #659: TenantMappingTable の tenantStatus を CFn / provisioning 結果に合わせて
 * 自動遷移するための pure policy。
 *
 * 入力は scan で取り出した row 1 件 + 現在時刻 (UTC ms)。 副作用なし、 純粋関数。
 * Lambda handler は 各 row に本関数を適用し、 戻り値が "Complete" / "Failed" のときだけ
 * UpdateItem を発行する (= "In progress" 維持の不要書込みを避ける)。
 *
 * 判定基準 (= 過剰判定を避けて conservative に):
 *   - status が "In progress" / "IN_PROGRESS" / "Provisioning" でない → 触らない
 *   - tenantConfig に applicationAdminConsoleUrl OR userPoolId が含まれる → "Complete"
 *     (= provision-tenant.sh が CFn output を JSON 書き戻したシグナル)
 *   - createdAt から 60 分超 + 上記未充足 → "Failed" + 推定理由
 *   - それ以外 (= まだ deploy 中) → 維持
 *
 * Phase 2 で CodePipeline event を直接 listen する設計に移行可能だが、 SBT pipeline は
 * 複数 tenant を batch 処理するため 1 execution = N tenants で対応 mapping を取れない。
 * 本実装は CFn output 経由の indirection で十分に正確 (= bash 完了 = 安定状態)。
 */

const PROGRESS_TIMEOUT_MS = 60 * 60 * 1000; // 60 分

export type ReconcileVerdict =
  | { readonly action: "skip" }
  | { readonly action: "complete" }
  | { readonly action: "fail"; readonly reason: string };

export interface ReconcilerInput {
  readonly tenantStatus: string | undefined;
  readonly tenantConfig: string | undefined;
  readonly createdAt: string | undefined;
  readonly nowMs: number;
}

function isInProgress(status: string | undefined): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return s === "in progress" || s === "in_progress" || s === "provisioning";
}

function hasMeaningfulTenantConfig(rawJson: string | undefined): boolean {
  if (!rawJson) return false;
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    return Boolean(parsed.applicationAdminConsoleUrl) || Boolean(parsed.userPoolId);
  } catch {
    return false;
  }
}

function parseCreatedAtMs(createdAt: string | undefined): number | null {
  if (!createdAt) return null;
  const t = Date.parse(createdAt);
  return Number.isNaN(t) ? null : t;
}

export function decideReconcile(input: ReconcilerInput): ReconcileVerdict {
  if (!isInProgress(input.tenantStatus)) return { action: "skip" };
  if (hasMeaningfulTenantConfig(input.tenantConfig)) return { action: "complete" };

  const createdMs = parseCreatedAtMs(input.createdAt);
  if (createdMs !== null && input.nowMs - createdMs > PROGRESS_TIMEOUT_MS) {
    return {
      action: "fail",
      reason: "Provisioning timed out (>60 min) without CFn output",
    };
  }

  return { action: "skip" };
}
