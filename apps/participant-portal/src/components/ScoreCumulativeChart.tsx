import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import LineChart from "@cloudscape-design/components/line-chart";
import { useT } from "../i18n";
import type { ChartPoint } from "../lib/score-events-chart";

/**
 * 自チームの累積スコア折れ線。 `ScoreEventsPage` から切り出し、 LineChart / Container 依存を
 * この module に閉じ込めた (= ページの高結合を解消)。 series と x 軸 domain を受け取るだけの
 * presentational component で、 取得や polling は持たない。
 */
export function ScoreCumulativeChart({
  series,
  xDomain,
}: {
  series: readonly ChartPoint[];
  xDomain: [Date, Date] | undefined;
}) {
  const t = useT();
  return (
    <Container header={<Header variant="h2">{t("score_events.cumulative_header")}</Header>}>
      <LineChart
        series={[
          {
            title: t("score_events.cumulative_series_label"),
            type: "line",
            data: series.map((p) => ({ x: p.x, y: p.y })),
          },
        ]}
        xDomain={xDomain}
        xScaleType="time"
        xTitle={t("score_events.chart_x_title")}
        yTitle={t("score_events.chart_y_title")}
        height={240}
        i18nStrings={{
          xTickFormatter: (d) =>
            new Date(d).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            }),
        }}
        empty={
          <Box textAlign="center" padding="m" color="text-status-inactive">
            {t("score_events.chart_empty")}
          </Box>
        }
        ariaLabel={t("score_events.chart_aria_label")}
      />
    </Container>
  );
}
