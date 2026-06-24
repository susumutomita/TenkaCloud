import type { ScoreEventView } from "../api/portal-client";

/** 累積スコア折れ線の 1 data point (= 時刻 x と、その時点までの累積得点 y)。 */
export interface ChartPoint {
  readonly x: Date;
  readonly y: number;
}

/**
 * score-event 列を「競技開始からの累積スコア」 折れ線の data point 列に変換する。
 *
 * 入力順序に依存しないよう occurredAt 昇順に並べ替えてから 0 origin で積み上げる
 * (= polling で並びが変わっても同じ chart になる)。 parse できない occurredAt は累積には
 * 加算した上で点を打たずに skip する (= 旧 ScoreEventsPage の挙動を保存)。
 */
export function buildCumulativeSeries(entries: readonly ScoreEventView[]): readonly ChartPoint[] {
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
 * 折れ線の x 軸 domain (= 最初と最後の点の時刻)。 series が空なら undefined を返す
 * (= LineChart は empty 表示)。 旧実装の `series[0]?.x ?? new Date()` は系列欠損時に
 * 「現在時刻」 を軸端に捏造する silent fallback だったため、 明示的に undefined を返す
 * (no-silent-fallback)。
 */
export function chartXDomain(series: readonly ChartPoint[]): [Date, Date] | undefined {
  const firstPoint = series[0];
  const lastPoint = series[series.length - 1];
  return firstPoint && lastPoint ? [firstPoint.x, lastPoint.x] : undefined;
}
