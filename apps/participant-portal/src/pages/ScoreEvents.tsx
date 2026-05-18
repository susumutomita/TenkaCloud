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
import type { AppConfig } from "../config";
import { describeAgo, formatOccurredAtTooltip } from "../lib/format";

// Lambda invocation コスト抑制のため 30 秒 (= 旧 5 秒は 12 req/min/user で過多)。
const POLL_INTERVAL_MS = 30_000;

/**
 * Issue #1001: 加点 / 減点を区別するラベル + 色。
 * - uptime / flag : 加点系 (green / blue)
 * - flag-wrong / hint : 減点系 (red / grey)
 */
const SOURCE_LABEL: Record<ScoreEventView["source"], string> = {
  uptime: "Battle (uptime)",
  flag: "Challenge (flag)",
  "flag-wrong": "不正解 flag",
  hint: "ヒント開封",
};

const SOURCE_COLOR: Record<ScoreEventView["source"], "blue" | "green" | "grey" | "red"> = {
  uptime: "green",
  flag: "blue",
  "flag-wrong": "red",
  hint: "grey",
};

/**
 * Issue #1002: 累計 score を時系列に並べる data point を作る。 entries は新しい順なので
 * reverse して古い順にしてから累積加算する。
 */
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

/**
 * 自チームのスコア変動履歴 (sidebar 「Score events」)。新しい順 100 件まで表示。
 *
 * データ source は `getScoreEvents` を 30 秒間隔で polling。HealthCheck (uptime 成功) /
 * 競技者の flag 提出 (正解) / ヒント開封による減点 / 不正解 flag による減点を merge 済。
 *
 * Issue #1002: 上部に累計 score の折れ線グラフを追加 (Cloudscape LineChart)。
 * X 軸 = wall-clock 時刻、 Y 軸 = cumulative score。 hover で 1 point の詳細 (時刻 +
 * cumulative score) を tooltip。
 */
export function ScoreEventsPage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const sessionToken = auth.session?.sessionToken ?? null;
  const isBackend = config.mode === "backend";

  const [data, setData] = useState<ScoreEventsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tick = useCallback(async () => {
    if (!isBackend || !sessionToken) return;
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
  }, [isBackend, sessionToken, config.apiBaseUrl, auth]);

  useEffect(() => {
    if (!isBackend || !sessionToken) return;
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
  }, [isBackend, sessionToken, tick]);

  const series = useMemo(() => (data ? buildCumulativeSeries(data.entries) : []), [data]);

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={`自チームのスコア変動履歴 (${POLL_INTERVAL_MS / 1000} 秒ごと自動更新、新しい順 100 件まで)`}
      >
        Score events
      </Header>

      {!isBackend && (
        <Alert type="info">
          dev-mock モードで動作中です。実 backend と接続するには runtime-config の <code>mode</code>{" "}
          を <code>backend</code> に設定してください。
        </Alert>
      )}
      {error && (
        <Alert type="error" header="状態の取得に失敗しました">
          {error}
        </Alert>
      )}
      {isBackend && !data && !error && (
        <Box textAlign="center" padding="l">
          <Spinner /> 状態を取得中…
        </Box>
      )}

      {data && series.length > 0 && (
        <Container header={<Header variant="h2">累計 score 推移</Header>}>
          <LineChart
            series={[
              {
                title: "累計 score",
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
            xTitle="時刻"
            yTitle="累計 score"
            height={240}
            i18nStrings={{
              xTickFormatter: (d) =>
                new Date(d).toLocaleTimeString("ja-JP", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                }),
            }}
            empty={
              <Box textAlign="center" padding="m" color="text-status-inactive">
                データなし
              </Box>
            }
            ariaLabel="累計 score の時系列"
          />
        </Container>
      )}

      {data && (
        <Container header={<Header variant="h2">{`履歴 (${data.entries.length})`}</Header>}>
          <Table<ScoreEventView>
            variant="embedded"
            items={[...data.entries]}
            columnDefinitions={[
              {
                id: "occurredAt",
                header: "発生時刻",
                // #548: 相対時刻だけ表示し、絶対時刻 (UTC + ローカル) は cell hover の
                // tooltip (= title 属性) で出す。ISO + 相対が連結して読めない bug と
                // UTC 表示が直感的でない問題を同時に解消。Score events は「最近採点
                // されたか」の即時 feedback が主用途なので relative 表示が一次情報。
                cell: (e) => (
                  <span title={formatOccurredAtTooltip(e.occurredAt)}>
                    {describeAgo(e.occurredAt, Date.now())}
                  </span>
                ),
              },
              {
                id: "problemId",
                header: "問題",
                cell: (e) => <code>{e.problemId}</code>,
              },
              {
                id: "source",
                header: "種類",
                cell: (e) => <Badge color={SOURCE_COLOR[e.source]}>{SOURCE_LABEL[e.source]}</Badge>,
                width: 180,
              },
              {
                id: "points",
                header: "変動",
                // Issue #1001: 負の数は赤、 正の数は緑で 「±N pt」 を表示。
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
                <Box variant="strong">まだスコア変動履歴がありません</Box>
                <Box variant="small" color="text-status-inactive" padding={{ top: "s" }}>
                  競技開始後、HealthCheck の uptime 成功 / flag 提出 /
                  ヒント開封などでスコアが動くと履歴がここに並びます。
                </Box>
              </Box>
            }
          />
        </Container>
      )}
    </SpaceBetween>
  );
}
