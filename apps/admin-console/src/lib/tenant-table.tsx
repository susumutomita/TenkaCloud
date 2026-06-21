import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { isTenantSuspended, type Tenant, tenantStatusBadgeColor } from "../api/tenants";
import { computeTenantProgress, isInProgress } from "./tenant-progress";

export type TFn = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/**
 * deprovision 済みの tenant かどうかを判定する。
 *   - tenantStatus が "Deleted" / "DELETED" / "Deprovisioned" のいずれか
 *   - または isActive === false (SBT v0.3.9 の DELETE /tenants は isActive = false にする)
 *
 * 該当する行は Application Console / ログ / 操作 カラムをすべて灰色 "(deprovisioned)"
 * 表示にし、active なリンクは出さない。
 */
export function isDeprovisioned(t: Tenant): boolean {
  const status = (t.tenantStatus ?? "").toLowerCase();
  if (status === "deleted" || status === "deprovisioned") return true;
  if (t.isActive === false) return true;
  return false;
}

export function inactiveCell(label: string) {
  return (
    <Box color="text-status-inactive" variant="small">
      {label}
    </Box>
  );
}

export function tenantStatusCell(row: Tenant, nowMs: number, t: TFn) {
  const badge = <Badge color={tenantStatusBadgeColor(row.tenantStatus)}>{row.tenantStatus}</Badge>;
  if (isTenantSuspended(row)) {
    return (
      <SpaceBetween direction="vertical" size="xxs">
        {badge}
        <Badge color="red">{t("tenant_list.suspended_badge")}</Badge>
      </SpaceBetween>
    );
  }
  if (!isInProgress(row.tenantStatus)) return badge;
  const progress = computeTenantProgress({ createdAt: row.createdAt, nowMs });
  // createdAt 未取得 (= SBT が field を返さない、 fresh tenant の race) のとき
  // `progress.label === "—"` が出る。 細い em dash が badge 下に "_" のように
  // 見えて誤解を生むので、 そのときは badge のみ表示する。
  if (progress.label === "—") return badge;
  const progressColor =
    progress.severity === "danger"
      ? "text-status-error"
      : progress.severity === "warning"
        ? "text-status-warning"
        : "text-status-info";
  const suffix =
    progress.severity === "danger"
      ? ` · ${t("tenant_list.progress_danger_suffix")}`
      : progress.severity === "warning"
        ? ` · ${t("tenant_list.progress_warning_suffix")}`
        : "";
  return (
    <SpaceBetween direction="vertical" size="xxs">
      {badge}
      <Box variant="small" color={progressColor}>
        {progress.label}
        {suffix}
      </Box>
    </SpaceBetween>
  );
}
