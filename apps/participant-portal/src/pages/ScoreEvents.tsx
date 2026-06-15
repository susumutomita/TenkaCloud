import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import LineChart from "@cloudscape-design/components/line-chart";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Toggle from "@cloudscape-design/components/toggle";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { ScoreEventsTable } from "./ScoreEventsTable";

const POLL_INTERVAL_MS = 30_000;

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
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);

  const tick = useCallback(async () => {
    // 呼び出し元の useEffect が同条件を gate 済み。 ここは getScoreEvents に渡す
    // sessionToken を string へ narrow するための型ガードで、 true 分岐は不到達。
    /* v8 ignore next */
    if (isMock || !sessionToken) return;
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const run = (async () => {
      setIsRefreshing(true);
      try {
        const next = await getScoreEvents(config.apiBaseUrl, sessionToken);
        setData(next);
        setError(null);
      } catch (err) {
        if (err instanceof PortalAuthError) {
          auth.logout();
          return;
        }
        setError(toErrorMessage(err));
      } finally {
        refreshInFlightRef.current = null;
        setIsRefreshing(false);
      }
    })();
    refreshInFlightRef.current = run;
    return run;
  }, [isMock, sessionToken, config.apiBaseUrl, auth]);

  // 初回 fetch は 1 回だけ。30s polling は DynamoDB read 抑制のため opt-in。
  useEffect(() => {
    if (isMock || !sessionToken) return;
    void tick();
  }, [isMock, sessionToken, tick]);

  useEffect(() => {
    if (!autoRefresh || isMock || !sessionToken) return;
    const interval = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [autoRefresh, isMock, sessionToken, tick]);

  // LP 「モックで試す」 動線: dev-mock mode では backend を叩かないので、 fixture を
  // 1 度だけ seed する (= 競技中のスコア推移 chart + 履歴 table をデモで見せる)。
  useEffect(() => {
    if (!isMock) return;
    if (!sessionToken) return;
    if (data) return;
    setData(DEV_MOCK_SCORE_EVENTS);
  }, [isMock, sessionToken, data]);

  const series = useMemo(() => (data ? buildCumulativeSeries(data.entries) : []), [data]);
  // chart x 軸 domain。 series が空なら undefined (= LineChart は empty 表示)。 旧実装の
  // `series[0]?.x ?? new Date()` は系列欠損時に「現在時刻」を軸端に捏造する silent fallback
  // だったので、 明示的に undefined を返すよう改めた (no-silent-fallback)。
  const firstPoint = series[0];
  const lastPoint = series[series.length - 1];
  const xDomain: [Date, Date] | undefined =
    firstPoint && lastPoint ? [firstPoint.x, lastPoint.x] : undefined;

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={t("score_events.description", { intervalSec: POLL_INTERVAL_MS / 1000 })}
        actions={
          !isMock && sessionToken ? (
            <SpaceBetween direction="horizontal" size="s">
              <Toggle
                checked={autoRefresh}
                onChange={({ detail }) => setAutoRefresh(detail.checked)}
              >
                {t("score_events.auto_refresh_label", { intervalSec: POLL_INTERVAL_MS / 1000 })}
              </Toggle>
              <Button iconName="refresh" loading={isRefreshing} onClick={() => void tick()}>
                {t("score_events.refresh_latest")}
              </Button>
            </SpaceBetween>
          ) : undefined
        }
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
      )}

      {data && (
        <Container
          header={
            <Header variant="h2">
              {t("score_events.history_header", { count: data.entries.length })}
            </Header>
          }
        >
          <ScoreEventsTable entries={data.entries} />
        </Container>
      )}
    </SpaceBetween>
  );
}
