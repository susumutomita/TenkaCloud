import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import { type ReactNode, useMemo } from "react";
import type { DisruptionAuditRow } from "../../api/disruptions-client";
import type { EventDetail } from "../../api/events-client";
import {
  assembleTeamStatus,
  type TeamDeployStatus,
  type TeamLatestScoring,
  type TeamStatusRow,
} from "../../lib/team-status";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/**
 * Issue #1916: disruption console の隣に「各チームの現在地」を出して、 operator が
 * 障害を撃つ timing を判断できるようにする read-only な status table。 score/rank・deploy・
 * 直近採点・撃ち込んだ disruption 履歴を、既存 read (`EventDetail` + disruption audit) だけ
 * から組み立て、問題固有の状態判定には踏み込まない。
 */

/** ISO8601 → "HH:mm"。 null は "—"。 */
export function formatHm(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function rankCell(rank: number): ReactNode {
  if (rank === 1) return <Badge color="green">1</Badge>;
  if (rank <= 3) return <Badge color="blue">{rank}</Badge>;
  return <Box variant="strong">{rank}</Box>;
}

function deployCell(deploy: TeamDeployStatus, t: Translate): ReactNode {
  if (deploy.total === 0) {
    return <Box color="text-status-inactive">{t("disruptions.team_status_deploy_none")}</Box>;
  }
  if (deploy.failed > 0) {
    return (
      <StatusIndicator type="error">
        {t("disruptions.team_status_deploy_failed", { count: deploy.failed })}
      </StatusIndicator>
    );
  }
  if (deploy.inProgress > 0) {
    return (
      <StatusIndicator type="in-progress">
        {t("disruptions.team_status_deploy_progress", { count: deploy.inProgress })}
      </StatusIndicator>
    );
  }
  return (
    <StatusIndicator type="success">
      {t("disruptions.team_status_deploy_up", { complete: deploy.complete, total: deploy.total })}
    </StatusIndicator>
  );
}

function latestCell(latest: TeamLatestScoring | null, t: Translate): ReactNode {
  if (!latest) {
    return <Box color="text-status-inactive">{t("disruptions.team_status_latest_none")}</Box>;
  }
  return (
    <SpaceBetween direction="horizontal" size="xs">
      <StatusIndicator type={latest.result === "ok" ? "success" : "error"}>
        {latest.source}
      </StatusIndicator>
      <Box variant="small" color="text-status-inactive">
        {formatHm(latest.occurredAt)}
      </Box>
    </SpaceBetween>
  );
}

function firedCell(row: TeamStatusRow, t: Translate): ReactNode {
  if (row.disruptionsFired === 0) {
    return <Box color="text-status-inactive">{t("disruptions.team_status_fired_none")}</Box>;
  }
  return (
    <Box>
      {t("disruptions.team_status_fired_count", {
        count: row.disruptionsFired,
        time: formatHm(row.lastFiredAt),
      })}
    </Box>
  );
}

export function TeamStatusPanel({
  detail,
  audit,
  t,
}: {
  readonly detail: EventDetail;
  readonly audit: readonly DisruptionAuditRow[];
  readonly t: Translate;
}) {
  const rows = useMemo(() => assembleTeamStatus(detail, audit), [detail, audit]);
  return (
    <SpaceBetween size="s">
      <Header variant="h3" description={t("disruptions.team_status_description")}>
        {t("disruptions.team_status_header")}
      </Header>
      <Table
        variant="embedded"
        items={[...rows]}
        columnDefinitions={[
          {
            id: "rank",
            header: t("disruptions.team_status_col_rank"),
            cell: (r: TeamStatusRow) => rankCell(r.rank),
            width: 80,
          },
          {
            id: "team",
            header: t("disruptions.team_status_col_team"),
            cell: (r: TeamStatusRow) => <code>{r.teamName}</code>,
          },
          {
            id: "score",
            header: t("disruptions.team_status_col_score"),
            cell: (r: TeamStatusRow) => (
              <SpaceBetween direction="horizontal" size="xs">
                <Box variant="strong">{r.totalScore} pt</Box>
                <Box variant="small" color="text-status-inactive">
                  {t("disruptions.team_status_solved", { count: r.problemsSolved })}
                </Box>
              </SpaceBetween>
            ),
          },
          {
            id: "deploy",
            header: t("disruptions.team_status_col_deploy"),
            cell: (r: TeamStatusRow) => deployCell(r.deploy, t),
          },
          {
            id: "latest",
            header: t("disruptions.team_status_col_latest"),
            cell: (r: TeamStatusRow) => latestCell(r.latest, t),
          },
          {
            id: "fired",
            header: t("disruptions.team_status_col_fired"),
            cell: (r: TeamStatusRow) => firedCell(r, t),
          },
        ]}
        empty={<Box textAlign="center">{t("disruptions.team_status_empty")}</Box>}
      />
    </SpaceBetween>
  );
}
