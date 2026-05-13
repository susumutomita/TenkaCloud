import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Table from "@cloudscape-design/components/table";
import { useCallback, useEffect, useState } from "react";
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

const SOURCE_LABEL: Record<ScoreEventView["source"], string> = {
  uptime: "Battle (uptime)",
  flag: "Challenge (flag)",
};

const SOURCE_COLOR: Record<ScoreEventView["source"], "blue" | "green" | "grey" | "red"> = {
  uptime: "green",
  flag: "blue",
};

/**
 * 自チームの加点履歴 (sidebar 「Score events」)。新しい順 100 件まで表示。
 *
 * データ source は `getScoreEvents` を 5 秒間隔で polling。HealthCheck (uptime 成功) と
 * 競技者の flag 提出 (正解) の両方を merge 済。
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

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={`自チームの加点履歴 (${POLL_INTERVAL_MS / 1000} 秒ごと自動更新、新しい順 100 件まで)`}
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
                header: "加点",
                cell: (e) => (
                  <Box variant="strong" color="text-status-success">
                    +{e.points} pt
                  </Box>
                ),
                width: 100,
              },
            ]}
            empty={
              <Box textAlign="center" padding="l">
                <Box variant="strong">まだ加点履歴がありません</Box>
                <Box variant="small" color="text-status-inactive" padding={{ top: "s" }}>
                  競技開始後、HealthCheck の uptime 成功や flag
                  提出で加点されると履歴がここに並びます。
                </Box>
              </Box>
            }
          />
        </Container>
      )}
    </SpaceBetween>
  );
}
