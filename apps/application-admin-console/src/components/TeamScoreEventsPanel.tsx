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

/**
 * Cumulative score over time, anchored at zero.
 *
 * The anchor is not cosmetic. Without it a team with a single scoring event is one
 * isolated dot with nothing to draw a line to, and a team that has not scored at all is an
 * empty series — present in the legend, invisible on the chart. In a two-team Battle where
 * one team has solved exactly one problem, that is the whole picture: the operator sees
 * axes and a legend and reads it as "nothing is happening".
 *
 * Anchoring every team at `{startsAt, 0}` makes both cases say what is actually true —
 * "0 → 100" as a line, and "flat at 0" as a line — and pins the x-domain to the event
 * start so it cannot collapse to a single instant.
 *
 * `startsAt` is optional on EventDetail (#536: the backend returns only requested fields).
 * When it is missing or unparseable there is nothing truthful to anchor to, so the series
 * is left as-is rather than inventing an origin.
 */
function buildCumulative(
  team: TeamScoreEvents,
  originMs: number | undefined,
): readonly SeriesPoint[] {
  const points: SeriesPoint[] = [];
  let cum = 0;
  for (const e of team.events) {
    cum += e.points;
    const ts = Date.parse(e.occurredAt);
    if (!Number.isFinite(ts)) continue;
    points.push({ x: new Date(ts), y: cum });
  }
  if (originMs === undefined) return points;
  // A scoring event timestamped at or before the event start would make the series
  // non-monotonic in x, so only anchor ahead of the earliest point we actually have.
  const earliest = points[0]?.x.getTime();
  if (earliest !== undefined && earliest <= originMs) return points;
  return [{ x: new Date(originMs), y: 0 }, ...points];
}

/**
 * The chart's whole view model, extracted so the shape of the series is testable.
 * Rendering a Cloudscape LineChart in jsdom does not expose its points, and the two
 * defects this fixes (a lone dot, an invisible team) are entirely about those points.
 */
export function buildChartView(teams: readonly TeamScoreEvents[], startsAt?: string) {
  const parsedOrigin = startsAt === undefined ? Number.NaN : Date.parse(startsAt);
  const originMs = Number.isFinite(parsedOrigin) ? parsedOrigin : undefined;
  const series = teams.map((team, idx) => ({
    title: team.teamName || team.teamId,
    type: "line" as const,
    data: buildCumulative(team, originMs).map((p) => ({ x: p.x, y: p.y })),
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
  // Carry every series forward to the right edge at its current total. An anchor alone
  // is not enough for a team that has not scored: origin-only is still a single dot. A
  // cumulative score also genuinely holds its value until the next event, so extending
  // is what the data means, not a drawing trick — "flat at 0" and "still leading at 100"
  // both become readable lines instead of a dot and a gap.
  for (const s of series) {
    const last = s.data.at(-1);
    if (last && last.x.getTime() < maxX.getTime()) {
      s.data = [...s.data, { x: maxX, y: last.y }];
    }
  }
  const allY = series.flatMap((s) => s.data.map((d) => d.y));
  const minY = allY.length > 0 ? Math.min(0, ...allY) : 0;
  const maxY = allY.length > 0 ? Math.max(10, ...allY) : 10;
  return { series, minX, maxX, minY, maxY };
}

export function TeamScoreEventsPanel({
  teams,
  startsAt,
}: {
  teams: readonly TeamScoreEvents[];
  /** Event start, used as the zero anchor for every team's series. */
  startsAt?: string;
}) {
  const t = useT();
  const view = useMemo(() => buildChartView(teams, startsAt), [teams, startsAt]);

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
