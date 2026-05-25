import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type {
  EventDeploymentStatus,
  EventDeploymentSummary,
  EventDetail,
  EventStatus,
} from "../../api/events-client";
import { computeEffectiveStatus, type EffectiveStatus } from "../../lib/effective-event-status";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

const DEPLOY_STATUS_COLOR: Record<EventDeploymentStatus, "blue" | "green" | "grey" | "red"> = {
  PENDING: "grey",
  IN_PROGRESS: "blue",
  COMPLETE: "green",
  FAILED: "red",
  DELETING: "grey",
  DELETED: "grey",
  EXPIRED: "red",
  AUTO_DELETED: "grey",
};

export const STATUS_COLOR: Record<EventStatus, "blue" | "green" | "grey" | "red"> = {
  DRAFT: "blue",
  DEPLOYING: "blue",
  READY: "green",
  ENDED: "grey",
  TEARDOWN: "red",
  ARCHIVED: "grey",
};

/**
 * #1330: effective status (= time-aware) ごとの badge 色。 RUNNING は競技進行中なので
 * 引き続き green、 READY は「未開始」 を示すため blue に降格 (= 真の RUNNING との差別化)。
 */
export const EFFECTIVE_STATUS_COLOR: Record<EffectiveStatus, "blue" | "green" | "grey" | "red"> = {
  DRAFT: "blue",
  DEPLOYING: "blue",
  READY: "blue",
  RUNNING: "green",
  ENDED: "grey",
  TEARDOWN: "red",
  ARCHIVED: "grey",
};

/**
 * #1330: Event detail の status badge。 Phase indicator と同じ time-aware ロジックで
 * effective status を計算して表示する (= DB の raw status は不変)。
 */
export function eventStatusBadge(
  detail: Pick<EventDetail, "status" | "startsAt" | "endsAt">,
  now: Date = new Date(),
) {
  const effective = computeEffectiveStatus(
    {
      status: detail.status,
      startsAt: detail.startsAt ?? null,
      endsAt: detail.endsAt ?? null,
    },
    now,
  );
  return <Badge color={EFFECTIVE_STATUS_COLOR[effective]}>{effective}</Badge>;
}

/**
 * 1 problem 行の deploy 状況サマリ: `成功 N / 全 M` + 失敗があれば赤 Badge を併記。
 * Bulk Deploy 未実行 (deployments 無し) なら "未デプロイ" 表示。
 */
export function renderProblemDeployStatus(
  deployments: readonly EventDeploymentSummary[] | undefined,
  t: Translate,
) {
  if (!deployments || deployments.length === 0) {
    return (
      <Box variant="small" color="text-status-inactive">
        {t("event_detail.deploy_status_undeployed")}
      </Box>
    );
  }
  const total = deployments.length;
  const complete = deployments.filter(
    (d) => d.status === "COMPLETE" || d.status === "AUTO_DELETED",
  ).length;
  const failed = deployments.filter((d) => d.status === "FAILED" || d.status === "EXPIRED").length;
  const inFlight = deployments.filter(
    (d) => d.status === "PENDING" || d.status === "IN_PROGRESS" || d.status === "DELETING",
  ).length;
  return (
    <SpaceBetween direction="horizontal" size="xs" alignItems="center">
      <Box variant="strong">
        {complete} / {total}
      </Box>
      {failed > 0 && (
        <Badge color="red">{t("event_detail.deploy_status_failed_badge", { count: failed })}</Badge>
      )}
      {inFlight > 0 && (
        <Badge color="blue">{t("event_detail.deploy_status_in_flight", { count: inFlight })}</Badge>
      )}
    </SpaceBetween>
  );
}

/**
 * 1 problem 行の deploy job click-through link 列 (#533)。
 */
export function renderProblemJobLinks(deployments: readonly EventDeploymentSummary[] | undefined) {
  if (!deployments || deployments.length === 0) {
    return (
      <Box variant="small" color="text-status-inactive">
        —
      </Box>
    );
  }
  return (
    <SpaceBetween direction="vertical" size="xxs">
      {deployments.map((d, i) => (
        <SpaceBetween key={d.jobId} direction="horizontal" size="xxs" alignItems="center">
          <Link
            href={`/deployments/${encodeURIComponent(d.jobId)}`}
            external={false}
            ariaLabel={`Deploy job 詳細 (status: ${d.status})`}
          >
            Job #{i + 1} ↗
          </Link>
          <Badge color={DEPLOY_STATUS_COLOR[d.status]}>{d.status}</Badge>
        </SpaceBetween>
      ))}
    </SpaceBetween>
  );
}

/**
 * Event の採点状況バッジ。 #1095: status / scoringLocked / 時刻の優先順位で分岐。
 */
export function scoringBadge(
  detail: Pick<EventDetail, "startsAt" | "status" | "scoringLocked">,
  t: (key: string) => string,
) {
  if (detail.scoringLocked === true)
    return <Badge color="red">{t("event_detail.scoring_badge_locked")}</Badge>;
  if (detail.status === "ENDED" || detail.status === "ARCHIVED" || detail.status === "TEARDOWN") {
    return <Badge color="grey">{t("event_detail.scoring_badge_ended")}</Badge>;
  }
  if (!detail.startsAt)
    return <Badge color="grey">{t("event_detail.scoring_badge_not_started")}</Badge>;
  if (new Date(detail.startsAt).getTime() > Date.now()) {
    return <Badge color="blue">{t("event_detail.scoring_badge_scheduled")}</Badge>;
  }
  return <Badge color="green">{t("event_detail.scoring_badge_active")}</Badge>;
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <div>{children}</div>
    </div>
  );
}
