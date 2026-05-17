import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import LineChart from "@cloudscape-design/components/line-chart";
import { useEffect, useMemo, useState } from "react";
import { getScoreEvents, type ScoreEventView } from "../api/portal-client";

/**
 * audit table #12: 競技開始からの得点状況を折れ線グラフで可視化する機能 (= 旧 UI には無かった)。
 *
 * /portal/me/score-events から取得した加点履歴 (= 時系列降順、 100 件まで) を 累積加点に変換し
 * Cloudscape LineChart で render する。 polling せず on-mount + 30 秒間隔 refresh で十分
 * (= score event は flag 提出 / uptime probe 成功時にしか増えないので秒単位で見たくはない)。
 *
 * `onScoredKey` (= 親が onScored 後に increment する key) を depend に取って、 flag 提出直後の
 * refresh を即時に反映する。
 */
const POLL_INTERVAL_MS = 30_000;

export function ScoreTimelineChart({
  apiBaseUrl,
  sessionToken,
}: {
  apiBaseUrl: string;
  sessionToken: string;
}) {
  const [events, setEvents] = useState<readonly ScoreEventView[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    const fetchOnce = async () => {
      if (!sessionToken) return;
      try {
        const res = await getScoreEvents(apiBaseUrl, sessionToken, controller.signal);
        if (mounted) {
          setEvents(res.entries);
          setError(null);
        }
      } catch (err) {
        if (!mounted) return;
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void fetchOnce();
    const interval = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => {
      mounted = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [apiBaseUrl, sessionToken]);

  const series = useMemo(() => {
    if (!events) return [];
    // backend は降順で返すので、 timeline 用に昇順に並べ替えて cumulative sum する。
    const sorted = [...events].sort(
      (a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
    );
    let cum = 0;
    const data = sorted.map((e) => {
      cum += e.points;
      return { x: new Date(e.occurredAt), y: cum };
    });
    return data;
  }, [events]);

  if (error) {
    return (
      <Container header={<Header variant="h2">スコア推移</Header>}>
        <Box color="text-status-error">取得失敗: {error}</Box>
      </Container>
    );
  }

  if (!events) {
    return (
      <Container header={<Header variant="h2">スコア推移</Header>}>
        <Box color="text-status-inactive">読み込み中…</Box>
      </Container>
    );
  }

  if (events.length === 0) {
    return (
      <Container header={<Header variant="h2">スコア推移</Header>}>
        <Box color="text-status-inactive">
          まだ得点履歴がありません。 flag 提出や Battle の uptime 加点で記録されます。
        </Box>
      </Container>
    );
  }

  return (
    <Container header={<Header variant="h2">スコア推移</Header>}>
      <LineChart
        series={[
          { title: "累計スコア", type: "line", data: series, valueFormatter: (v) => `${v} pt` },
        ]}
        xDomain={[series[0]?.x ?? new Date(), series[series.length - 1]?.x ?? new Date()]}
        yDomain={[0, Math.max(10, ...series.map((p) => p.y))]}
        xScaleType="time"
        i18nStrings={{
          xTickFormatter: (d: Date) =>
            d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }),
          yTickFormatter: (n: number) => `${n}`,
        }}
        height={240}
        xTitle="時刻"
        yTitle="累計スコア (pt)"
        ariaLabel="競技開始からのスコア推移 (累積)"
        empty={<Box color="text-status-inactive">データなし</Box>}
        noMatch={<Box color="text-status-inactive">範囲内にデータなし</Box>}
      />
    </Container>
  );
}
