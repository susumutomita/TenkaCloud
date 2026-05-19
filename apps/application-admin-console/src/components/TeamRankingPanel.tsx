import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Table from "@cloudscape-design/components/table";
import { useMemo } from "react";
import type { TeamScoreEvents } from "../api/events-client";

/**
 * Issue #1071: EventDetail 用チームランキング table。
 *
 * `scoreEventsByTeam` の events[] を team 毎に合計し、 累計 score 降順で sort して順位を出す。
 * 同点は最終 update が早い方を上位 (= 早く到達した方が有利、 一般的な競技 tie-break)。
 *
 * 既存 \`TeamScoreEventsPanel\` (= 時系列 chart) と同 data source。 backend 追加なし。
 * polling で自動更新される。
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
    // 同点は 最終 update が早い (= 小さい ms) を上位。 update 無しは最下位扱い。
    const aLast = a.lastUpdateMs ?? Number.POSITIVE_INFINITY;
    const bLast = b.lastUpdateMs ?? Number.POSITIVE_INFINITY;
    return aLast - bLast;
  });
  // 同点は同順位 (= 標準的な競技 ranking)。
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
  const rows = useMemo(() => computeRanking(teams), [teams]);
  if (rows.length === 0) {
    return null;
  }
  return (
    <Container
      header={
        <Header
          variant="h2"
          description="累計 score 降順で sort。 同点は最終 update が早い方を上位 (= 標準 tie-break)"
        >
          現在の順位 ({rows.length} チーム)
        </Header>
      }
    >
      <Table
        variant="embedded"
        items={[...rows]}
        columnDefinitions={[
          {
            id: "rank",
            header: "順位",
            cell: (r) =>
              r.rank === 1 ? (
                <Badge color="green">1</Badge>
              ) : r.rank <= 3 ? (
                <Badge color="blue">{r.rank}</Badge>
              ) : (
                <Box variant="strong">{r.rank}</Box>
              ),
          },
          { id: "name", header: "チーム名", cell: (r) => <code>{r.teamName}</code> },
          {
            id: "score",
            header: "累計 score",
            cell: (r) => <Box variant="strong">{r.totalScore} pt</Box>,
          },
          {
            id: "lastUpdate",
            header: "最終 update",
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
