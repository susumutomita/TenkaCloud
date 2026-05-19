import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Table from "@cloudscape-design/components/table";
import { useMemo } from "react";
import type { TeamScoreEvents } from "../api/events-client";
import { useT } from "../i18n";

/**
 * Issue #1071: EventDetail 用チームランキング table。
 *
 * `scoreEventsByTeam` の events[] を team 毎に合計し、累計 score 降順で sort して順位を出す。
 * 同点は最終 update が早い方を上位 (= 早く到達した方が有利、一般的な競技 tie-break)。
 */

interface RankingRow {
  rank: number;
  teamId: string;
  teamName: string;
  totalScore: number;
  lastUpdateMs: number | undefined;
}

export function computeRanking(teams: readonly TeamScoreEvents[]): readonly RankingRow[] {
  const aggregated = teams.map((t) => {
    const total = t.events.reduce((acc, e) => acc + e.points, 0);
    const lastUpdate =
      t.events.length > 0
        ? Math.max(...t.events.map((e) => new Date(e.occurredAt).getTime()))
        : undefined;
    return {
      teamId: t.teamId,
      teamName: t.teamName,
      totalScore: total,
      lastUpdateMs: lastUpdate,
    };
  });
  const sorted = [...aggregated].sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    const aLast = a.lastUpdateMs ?? Number.POSITIVE_INFINITY;
    const bLast = b.lastUpdateMs ?? Number.POSITIVE_INFINITY;
    return aLast - bLast;
  });
  let prevScore: number | null = null;
  let prevRank = 0;
  return sorted.map((row, idx) => {
    const rank = prevScore !== null && row.totalScore === prevScore ? prevRank : idx + 1;
    prevScore = row.totalScore;
    prevRank = rank;
    return { rank, ...row };
  });
}

function formatLastUpdate(ms: number | undefined): string {
  if (ms === undefined) return "—";
  const d = new Date(ms);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

export function TeamRankingPanel({ teams }: { teams: readonly TeamScoreEvents[] }) {
  const t = useT();
  const rows = useMemo(() => computeRanking(teams), [teams]);
  if (rows.length === 0) {
    return null;
  }
  return (
    <Container
      header={
        <Header variant="h2" description={t("team_ranking_panel.description")}>
          {t("team_ranking_panel.header", { count: rows.length })}
        </Header>
      }
    >
      <Table
        variant="embedded"
        items={[...rows]}
        columnDefinitions={[
          {
            id: "rank",
            header: t("team_ranking_panel.col_rank"),
            cell: (r) =>
              r.rank === 1 ? (
                <Badge color="green">1</Badge>
              ) : r.rank <= 3 ? (
                <Badge color="blue">{r.rank}</Badge>
              ) : (
                <Box variant="strong">{r.rank}</Box>
              ),
          },
          {
            id: "name",
            header: t("team_ranking_panel.col_team_name"),
            cell: (r) => <code>{r.teamName}</code>,
          },
          {
            id: "score",
            header: t("team_ranking_panel.col_score"),
            cell: (r) => <Box variant="strong">{r.totalScore} pt</Box>,
          },
          {
            id: "lastUpdate",
            header: t("team_ranking_panel.col_last_update"),
            cell: (r) => (
              <Box variant="small" color="text-status-inactive">
                {formatLastUpdate(r.lastUpdateMs)}
              </Box>
            ),
          },
        ]}
      />
    </Container>
  );
}
