import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import LineChart from "@cloudscape-design/components/line-chart";
import { useMemo } from "react";
import type { TeamScoreEvents } from "../api/events-client";
import { useT } from "../i18n";

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
  const t = useT();
  const view = useMemo(() => {
    const series = teams.map((team, idx) => ({
      title: team.teamName || team.teamId,
      type: "line" as const,
      data: buildCumulative(team).map((p) => ({ x: p.x, y: p.y })),
      // Cloudscape が tooltip hover 時のみ呼ぶ formatter (= jsdom render では不到達)。
      /* v8 ignore next */
      valueFormatter: (v: number) => `${v} pt`,
      // idx % length は常に有効なので ?? 右辺は型安全用の不到達分岐。
      /* v8 ignore next */
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
      <Container header={<Header variant="h2">{t("team_score_events_panel.header")}</Header>}>
        <Box color="text-status-inactive">{t("team_score_events_panel.empty")}</Box>
      </Container>
    );
  }

  return (
    <Container
      header={
        <Header
          variant="h2"
          description={t("team_score_events_panel.description", { count: teams.length })}
        >
          {t("team_score_events_panel.header")}
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
            d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
          yTickFormatter: (n: number) => `${n}`,
        }}
        height={320}
        xTitle={t("team_score_events_panel.x_title")}
        yTitle={t("team_score_events_panel.y_title")}
        ariaLabel={t("team_score_events_panel.aria_label")}
        empty={<Box color="text-status-inactive">{t("team_score_events_panel.chart_empty")}</Box>}
        noMatch={
          <Box color="text-status-inactive">{t("team_score_events_panel.chart_no_match")}</Box>
        }
      />
    </Container>
  );
}
