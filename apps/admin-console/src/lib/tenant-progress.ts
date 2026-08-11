/**
 * Issue #657: TenantList の "In progress" 進捗 helper。
 *
 * 現状 tenantStatus は SBT 由来の 1 string (`In progress` / `Complete` / `Failed` / `Deleted`) で、
 * 細粒度の phase 進行を fetch する経路がまだ無い。 frontend-only で改善できるのは:
 *   - `createdAt` からの 経過時間を表示 (= "5 分経過" / "1 時間経過")
 *   - 30 分超 / 60 分超で warning / danger 色に切り替え (= 失敗ハングの可能性を示唆)
 *
 * AdminInsight API は細粒度の provisioning phase を返さないため、sub-status は推測しない。
 */

export type ProgressSeverity = "ok" | "warning" | "danger";

export interface TenantProgress {
  readonly elapsedMs: number;
  readonly label: string;
  readonly severity: ProgressSeverity;
}

const WARN_THRESHOLD_MS = 30 * 60 * 1000; // 30 分
const DANGER_THRESHOLD_MS = 60 * 60 * 1000; // 60 分

/**
 * `createdAt` の ISO 8601 string と現在時刻から、 経過時間 + severity を計算する。
 *
 * - createdAt が parse 不能 / undefined のときは severity="ok" + label="—" を返す
 * - 30 分超 → warning (= "ハング疑いを operator に示す")
 * - 60 分超 → danger (= "明らかに stuck")
 */
export function computeTenantProgress(input: {
  readonly createdAt: string | undefined;
  readonly nowMs: number;
}): TenantProgress {
  if (!input.createdAt) {
    return { elapsedMs: 0, label: "—", severity: "ok" };
  }
  const createdMs = Date.parse(input.createdAt);
  if (Number.isNaN(createdMs)) {
    return { elapsedMs: 0, label: "—", severity: "ok" };
  }
  const elapsed = Math.max(0, input.nowMs - createdMs);
  const severity: ProgressSeverity =
    elapsed >= DANGER_THRESHOLD_MS ? "danger" : elapsed >= WARN_THRESHOLD_MS ? "warning" : "ok";
  return {
    elapsedMs: elapsed,
    label: formatElapsed(elapsed),
    severity,
  };
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (hours > 0) return `${hours} 時間 ${minutes} 分経過`;
  if (minutes > 0) return `${minutes} 分経過`;
  return `${totalSec} 秒経過`;
}

/**
 * tenantStatus 文字列が "In progress" 系のいずれかか判定する。
 * SBT は `In progress` を返すが、 ULID 系 backend が `IN_PROGRESS` / `Provisioning` で
 * 返すこともあるので、 lowercase compare で吸収する。
 */
export function isInProgress(tenantStatus: string | undefined): boolean {
  if (!tenantStatus) return false;
  const s = tenantStatus.toLowerCase();
  return s === "in progress" || s === "in_progress" || s === "provisioning";
}
