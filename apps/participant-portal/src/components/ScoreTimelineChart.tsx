import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import LineChart from "@cloudscape-design/components/line-chart";
import { useEffect, useMemo, useState } from "react";
import {
  getLeaderboardScoreEvents,
  type LeaderboardScoreEventsResponse,
  type TeamScoreEvents,
} from "../api/portal-client";
import { useI18n, useT } from "../i18n";

/**
 * audit table #12 + Issue #1038 P1 #6: 競技開始からの得点状況を折れ線グラフで可視化する。
 *
 * 旧版は自チームのみ 1 series。 Issue #1038 で「ライバルチームのスコアが見えないと面白くない」
 * との指摘を受け、 同 event の全 team を multi-series で render する。 自チームは強調
 * 色 + 太線、 rival は控えめなパレットで visually 区別する。
 *
 * `/portal/leaderboard/score-events` を 30 秒間隔で polling (= flag 提出 / uptime probe が
 * 5 秒間隔では反映されないので polling 周期を 30s にしたまま、 1 request で全 team を取得)。
 */
const POLL_INTERVAL_MS = 30_000;

/** Cloudscape の categorical palette 風。 my team は別 family (= status-success の green)。 */
const RIVAL_COLORS = [
  "#0972d3", // blue
  "#8d6cab", // purple
  "#e07700", // orange
  "#037f0c", // green (rival, my team とは違う緑トーン)
  "#a44b8c", // magenta
  "#5b6770", // steel
  "#b80f5a", // pink
];

const MY_TEAM_COLOR = "#037f0c";

/** rival series の色を巡回選択。 idx % length は常に有効なので ?? 右辺は型安全用の不到達分岐。 */
function rivalColor(idx: number): string {
  /* v8 ignore next */
  return RIVAL_COLORS[idx % RIVAL_COLORS.length] ?? "#5b6770";
}

interface SeriesPoint {
  readonly x: Date;
  readonly y: number;
}

type ScoreTimelineLoadResult =
  | { readonly kind: "ok"; readonly data: LeaderboardScoreEventsResponse }
  | { readonly kind: "skip" }
  | { readonly kind: "error"; readonly message: string };

/**
 * 1 team の event 列 (= occurredAt 昇順前提) を 累計スコア の data point 列に変換する。
 * 競技開始からの累積遷移を見たいので 0 origin から積み上げる。
 */
export function buildCumulativePoints(team: TeamScoreEvents): readonly SeriesPoint[] {
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

export function toScoreTimelineLoadError(err: unknown): ScoreTimelineLoadResult {
  if (err instanceof Error && err.name === "AbortError") return { kind: "skip" };
  return { kind: "error", message: err instanceof Error ? err.message : String(err) };
}

async function fetchScoreTimelineData(
  apiBaseUrl: string,
  sessionToken: string,
  signal: AbortSignal,
): Promise<ScoreTimelineLoadResult> {
  if (!sessionToken) return { kind: "skip" };
  try {
    const data = await getLeaderboardScoreEvents(apiBaseUrl, sessionToken, signal);
    if (!data) return { kind: "skip" };
    return { kind: "ok", data };
  } catch (err) {
    return toScoreTimelineLoadError(err);
  }
}

export function ScoreTimelineChart({
  apiBaseUrl,
  sessionToken,
}: {
  apiBaseUrl: string;
  sessionToken: string;
}) {
  const t = useT();
  const { locale } = useI18n();
  const [data, setData] = useState<LeaderboardScoreEventsResponse | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    const fetchOnce = async () => {
      const result = await fetchScoreTimelineData(apiBaseUrl, sessionToken, controller.signal);
      if (!mounted || result.kind === "skip") return;
      if (result.kind === "error") {
        setError(result.message);
        return;
      }
      setData(result.data);
      setError(null);
    };
    void fetchOnce();
    const interval = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => {
      mounted = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [apiBaseUrl, sessionToken]);

  const seriesView = useMemo(() => {
    if (!data) return null;
    // 自チームを最後に push して描画順を「rival 群 → 自チーム」 に揃える (= 自チームを最前面に)。
    const ordered = [...data.teams].sort((a, b) => {
      if (a.isMyTeam === b.isMyTeam) return 0;
      return a.isMyTeam ? 1 : -1;
    });
    let rivalIdx = 0;
    const built = ordered.map((team) => {
      const points = buildCumulativePoints(team);
      const color = team.isMyTeam ? MY_TEAM_COLOR : rivalColor(rivalIdx++);
      return {
        title: team.isMyTeam
          ? t("score_timeline.you_suffix", { teamName: team.teamName })
          : team.teamName,
        type: "line" as const,
        data: points.map((p) => ({ x: p.x, y: p.y })),
        // Cloudscape が tooltip hover 時にのみ呼ぶ formatter (= jsdom render では不到達)。
        /* v8 ignore next */
        valueFormatter: (v: number) => `${v} pt`,
        color,
      };
    });
    // X 軸 domain (= 全 team の最小 / 最大 timestamp)
    const allTs = built.flatMap((s) => s.data.map((d) => d.x.getTime()));
    const minX = allTs.length > 0 ? new Date(Math.min(...allTs)) : new Date();
    const maxX = allTs.length > 0 ? new Date(Math.max(...allTs)) : new Date();
    const allY = built.flatMap((s) => s.data.map((d) => d.y));
    const minY = allY.length > 0 ? Math.min(0, ...allY) : 0;
    const maxY = allY.length > 0 ? Math.max(10, ...allY) : 10;
    return { built, minX, maxX, minY, maxY };
  }, [data, t]);

  if (error) {
    return (
      <Container header={<Header variant="h2">{t("score_timeline.header")}</Header>}>
        <Box color="text-status-error">{t("score_timeline.fetch_failed", { error })}</Box>
      </Container>
    );
  }

  if (!data) {
    return (
      <Container header={<Header variant="h2">{t("score_timeline.header")}</Header>}>
        <Box color="text-status-inactive">{t("score_timeline.loading")}</Box>
      </Container>
    );
  }

  const totalEvents = data.teams.reduce((s, te) => s + te.events.length, 0);
  if (totalEvents === 0) {
    return (
      <Container header={<Header variant="h2">{t("score_timeline.header")}</Header>}>
        <Box color="text-status-inactive">{t("score_timeline.empty_body")}</Box>
      </Container>
    );
  }

  // data が truthy のここでは seriesView は必ず非 null (= 型 narrowing 用、 true 分岐は不到達)。
  /* v8 ignore next */
  if (!seriesView) return null;

  const localeTag = locale === "ja" ? "ja-JP" : "en-US";

  return (
    <Container
      header={
        <Header
          variant="h2"
          description={t("score_timeline.header_description", { count: data.teams.length })}
        >
          {t("score_timeline.header")}
        </Header>
      }
    >
      <LineChart
        series={seriesView.built}
        xDomain={[seriesView.minX, seriesView.maxX]}
        yDomain={[seriesView.minY, seriesView.maxY]}
        xScaleType="time"
        i18nStrings={{
          xTickFormatter: (d: Date) =>
            d.toLocaleTimeString(localeTag, { hour: "2-digit", minute: "2-digit" }),
          yTickFormatter: (n: number) => `${n}`,
        }}
        height={280}
        xTitle={t("score_timeline.x_title")}
        yTitle={t("score_timeline.y_title")}
        ariaLabel={t("score_timeline.aria_label")}
        empty={<Box color="text-status-inactive">{t("score_timeline.no_data")}</Box>}
        noMatch={<Box color="text-status-inactive">{t("score_timeline.no_match")}</Box>}
      />
    </Container>
  );
}
