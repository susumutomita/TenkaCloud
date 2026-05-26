import Badge from "@cloudscape-design/components/badge";
import type { ReactNode } from "react";

/**
 * Issue #1366: 共有 status badge wrapper。
 *
 * `docs/design-system/DESIGN-SYSTEM.html` の "5. Status badge system" で固定された 5 tone
 * (success / warning / error / info / pending) を Cloudscape `<Badge>` の color に lock する。
 *
 * - 直接 `<Badge color="green">` を書かない。 意味 (= tone) を経由することで、 後から
 *   tenant status / event status / deploy status の色変更を全 SPA 一括で行える。
 * - 3 SPA で同じ実装を copy-paste している (lib/format.ts と同じ理由)。 monorepo に shared
 *   package を切る大きな refactor は今 scope 外。
 */
export type StatusTone = "success" | "warning" | "error" | "info" | "pending";

/**
 * Cloudscape Badge は `green / blue / red / grey / severity-*` を palette として持つ。
 * "warning" は意味上 amber が欲しいので `severity-medium` (amber 系) を割り当てる。
 * これにより、 5 tone がすべて視覚的に区別される。
 */
const TONE_TO_COLOR: Record<StatusTone, "green" | "blue" | "red" | "grey" | "severity-medium"> = {
  success: "green",
  warning: "severity-medium",
  error: "red",
  info: "blue",
  pending: "grey",
};

export interface StatusBadgeProps {
  readonly tone: StatusTone;
  readonly children: ReactNode;
}

export function StatusBadge({ tone, children }: StatusBadgeProps) {
  return <Badge color={TONE_TO_COLOR[tone]}>{children}</Badge>;
}

/**
 * 既存 API (= `tenantStatusBadgeColor(status: string) -> "green" | "blue" | "red" | "grey"`)
 * との橋渡し。 status 文字列を直接 tone に翻訳したいときに使う。
 *
 * 未知の status は "pending" にフォールバック (= grey)。 これは「分からない = 表示は出すが
 * 強調しない」ポリシーで、 UI が壊れないことを優先する。
 */
const STATUS_TO_TONE: Record<string, StatusTone> = {
  // Tenant status (admin-console / SBT)
  PROVISIONING: "info",
  ACTIVE: "success",
  SUSPENDED: "warning",
  DELETING: "pending",
  DELETED: "pending",
  // Event status (application-admin-console)
  DRAFT: "pending",
  DEPLOYING: "info",
  READY: "info",
  RUNNING: "success",
  ENDED: "pending",
  TEARDOWN: "pending",
  ARCHIVED: "pending",
  // Deployment status (problem-deploy)
  PENDING: "info",
  IN_PROGRESS: "info",
  COMPLETE: "success",
  FAILED: "error",
  EXPIRED: "error",
  AUTO_DELETED: "pending",
};

export function statusToTone(status: string): StatusTone {
  return STATUS_TO_TONE[status] ?? "pending";
}
