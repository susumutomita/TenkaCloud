import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import LineChart from "@cloudscape-design/components/line-chart";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Table from "@cloudscape-design/components/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getScoreEvents,
  PortalAuthError,
  type ScoreEventsResponse,
  type ScoreEventView,
} from "../api/portal-client";
import { useAuth } from "../auth/AuthProvider";
import { DEV_MOCK_SCORE_EVENTS } from "../auth/dev-mock-fixtures";
import type { AppConfig } from "../config";
import { useIsMock } from "../config-context";
import { useT } from "../i18n";
import { describeAgo, formatOccurredAtTooltip } from "../lib/format";

const POLL_INTERVAL_MS = 30_000;

const SOURCE_KEY: Record<ScoreEventView["source"], string> = {
  uptime: "score_events.source_uptime",
  flag: "score_events.source_flag",
  "flag-wrong": "score_events.source_flag_wrong",
  hint: "score_events.source_hint",
};

const SOURCE_COLOR: Record<ScoreEventView["source"], "blue" | "green" | "grey" | "red"> = {
  uptime: "green",
  flag: "blue",
  "flag-wrong": "red",
  hint: "grey",
};

interface ChartPoint {
  readonly x: Date;
  readonly y: number;
}

function buildCumulativeSeries(entries: readonly ScoreEventView[]): readonly ChartPoint[] {
  if (entries.length === 0) return [];
  const oldestFirst = [...entries].sort((a, b) =>
    a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0,
  );
  const points: ChartPoint[] = [];
  let cumulative = 0;
  for (const e of oldestFirst) {
    cumulative += e.points;
    const ts = Date.parse(e.occurredAt);
    if (!Number.isFinite(ts)) continue;
    points.push({ x: new Date(ts), y: cumulative });
  }
  return points;
}

export function ScoreEventsPage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const t = useT();
  const sessionToken = auth.session?.sessionToken ?? null;
  const isMock = useIsMock();

  const [data, setData] = useState<ScoreEventsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tick = useCallback(async () => {
    if (isMock || !sessionToken) return;
    try {
      const next = await getScoreEvents(config.apiBaseUrl, sessionToken);
      setData(next);
      setError(null);
    } catch (err) {
      if (err instanceof PortalAuthError) {
        auth.logout();
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [isMock, sessionToken, config.apiBaseUrl, auth]);

  useEffect(() => {
    if (isMock || !sessionToken) return;
    let cancelled = false;
    const run = async () => {
      if (cancelled) return;
      await tick();
    };
    void run();
    const interval = setInterval(run, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isMock, sessionToken, tick]);

  // LP 「モックで試す」 動線: dev-mock mode では backend を叩かないので、 fixture を
  // 1 度だけ seed する (= 競技中のスコア推移 chart + 履歴 table をデモで見せる)。
  useEffect(() => {
    if (!isMock) return;
    if (!sessionToken) return;
    if (data) return;
    setData(DEV_MOCK_SCORE_EVENTS);
  }, [isMock, sessionToken, data]);

  const series = useMemo(() => (data ? buildCumulativeSeries(data.entries) : []), [data]);

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={t("score_events.description", { intervalSec: POLL_INTERVAL_MS / 1000 })}
      >
        {t("score_events.title")}
      </Header>

      {error && (
        <Alert type="error" header={t("app.fetch_status_failed")}>
          {error}
        </Alert>
      )}
      {!isMock && !data && !error && (
        <Box textAlign="center" padding="l">
          <Spinner /> {t("app.loading")}
        </Box>
      )}

      {data && series.length > 0 && (
        <Container header={<Header variant="h2">{t("score_events.cumulative_header")}</Header>}>
          <LineChart
            series={[
              {
                title: t("score_events.cumulative_series_label"),
                type: "line",
                data: series.map((p) => ({ x: p.x, y: p.y })),
              },
            ]}
            xDomain={
              series.length > 0
                ? [series[0]?.x ?? new Date(), series[series.length - 1]?.x ?? new Date()]
                : undefined
            }
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
      )}

      {data && (
        <Container
          header={
            <Header variant="h2">
              {t("score_events.history_header", { count: data.entries.length })}
            </Header>
          }
        >
          <Table<ScoreEventView>
            variant="embedded"
            items={[...data.entries]}
            columnDefinitions={[
              {
                id: "occurredAt",
                header: t("score_events.col_occurred_at"),
                cell: (e) => (
                  <span title={formatOccurredAtTooltip(e.occurredAt)}>
                    {describeAgo(e.occurredAt, Date.now())}
                  </span>
                ),
              },
              {
                id: "problemId",
                header: t("score_events.col_problem"),
                cell: (e) => <code>{e.problemId}</code>,
              },
              {
                id: "source",
                header: t("score_events.col_source"),
                cell: (e) => (
                  <Badge color={SOURCE_COLOR[e.source]}>{t(SOURCE_KEY[e.source])}</Badge>
                ),
                width: 180,
              },
              {
                id: "points",
                header: t("score_events.col_points"),
                cell: (e) =>
                  e.points >= 0 ? (
                    <Box variant="strong" color="text-status-success">
                      +{e.points} pt
                    </Box>
                  ) : (
                    <Box variant="strong" color="text-status-error">
                      {e.points} pt
                    </Box>
                  ),
                width: 100,
              },
            ]}
            empty={
              <Box textAlign="center" padding="l">
                <Box variant="strong">{t("score_events.empty_header")}</Box>
                <Box variant="small" color="text-status-inactive" padding={{ top: "s" }}>
                  {t("score_events.empty_hint")}
                </Box>
              </Box>
            }
          />
        </Container>
      )}
    </SpaceBetween>
  );
}
