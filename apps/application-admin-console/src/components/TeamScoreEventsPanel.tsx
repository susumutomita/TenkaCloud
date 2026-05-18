import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import LineChart from "@cloudscape-design/components/line-chart";
import { useMemo } from "react";
import type { TeamScoreEvents } from "../api/events-client";

/**
 * Issue #1038 P1 #7: operator (= tenant admin) 視点で全 team の score event 推移を一覧する panel。
 *
 * 旧 EventDetail には「どの team がいつ加点 / 減点したか」 を一目で見るビューが無かった。
 * `EventDetail.scoreEventsByTeam` (= ?withScoreEvents=true 経由で fetch) を multi-series
 * LineChart で render する。 全 team を categorical palette で描画 (= participant 側 chart と
 * 違って operator は自分の team が無いため特定 team の強調はしない)。
 *
 * Cloudscape の LineChart は内部で凡例 + 系列 toggle を持つので、 chart 自体に dropdown は
 * 追加しない (= 凡例 click で 1 系列のみ visible にできる)。
 */
const PALETTE = [
  "#0972d3",
  "#037f0c",
  "#8d6cab",
  "#e07700",
  "#a44b8c",
  "#5b6770",
  "#b80f5a",
  "#6f4e37",
  "#0a8c8a",
  "#cc4a00",
];

interface SeriesPoint {
  readonly x: Date;
  readonly y: number;
}

function buildCumulative(team: TeamScoreEvents): readonly SeriesPoint[] {
  const points: SeriesPoint[] = [];
  let cum = 0;
  for (const e of team.events) {
    cum += e.points;
    const ts = Date.parse(e.occurredAt);
    if (!Number.isFinite(ts)) continue;
    points.push({ x: new Date(ts), y: cum });
  }
  return points;
}

export function TeamScoreEventsPanel({ teams }: { teams: readonly TeamScoreEvents[] }) {
  const view = useMemo(() => {
    const series = teams.map((team, idx) => ({
      title: team.teamName || team.teamId,
      type: "line" as const,
      data: buildCumulative(team).map((p) => ({ x: p.x, y: p.y })),
      valueFormatter: (v: number) => `${v} pt`,
      color: PALETTE[idx % PALETTE.length] ?? "#5b6770",
    }));
    const allTs = series.flatMap((s) => s.data.map((d) => d.x.getTime()));
    const minX = allTs.length > 0 ? new Date(Math.min(...allTs)) : new Date();
    const maxX = allTs.length > 0 ? new Date(Math.max(...allTs)) : new Date();
    const allY = series.flatMap((s) => s.data.map((d) => d.y));
    const minY = allY.length > 0 ? Math.min(0, ...allY) : 0;
    const maxY = allY.length > 0 ? Math.max(10, ...allY) : 10;
    return { series, minX, maxX, minY, maxY };
  }, [teams]);

  const totalEvents = teams.reduce((s, t) => s + t.events.length, 0);

  if (totalEvents === 0) {
    return (
      <Container header={<Header variant="h2">全チーム スコア推移</Header>}>
        <Box color="text-status-inactive">
          まだスコア変動の履歴がありません。 flag 提出や Battle uptime / hint
          開封などで記録されます。
        </Box>
      </Container>
    );
  }

  return (
    <Container
      header={
        <Header
          variant="h2"
          description={`全 ${teams.length} チームの累計 score 推移 (凡例 click で系列の表示 / 非表示を切替)`}
        >
          全チーム スコア推移
        </Header>
      }
    >
      <LineChart
        series={view.series}
        xDomain={[view.minX, view.maxX]}
        yDomain={[view.minY, view.maxY]}
        xScaleType="time"
        i18nStrings={{
          xTickFormatter: (d: Date) =>
            d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }),
          yTickFormatter: (n: number) => `${n}`,
        }}
        height={320}
        xTitle="時刻"
        yTitle="累計スコア (pt)"
        ariaLabel="全チームの累計スコア推移"
        empty={<Box color="text-status-inactive">データなし</Box>}
        noMatch={<Box color="text-status-inactive">範囲内にデータなし</Box>}
      />
    </Container>
  );
}
