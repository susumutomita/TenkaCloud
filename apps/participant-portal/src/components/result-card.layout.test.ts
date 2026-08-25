import { describe, expect, it } from "vitest";
import type { LeaderboardResponse } from "../api/portal-client";
import { buildResultCardModel, renderResultCardSvg } from "./result-card";

/**
 * #3066: rank が 4 桁かつ score が 10 桁のように両方が同時に長い組み合わせでは、
 * SCORE と RANK (あるいは RANK と PROGRESS) の値テキストが重なる。既存の
 * result-card.test.ts はこの列の font-size 選択しか見ておらず、選んだ font-size で
 * 実際に描画される幅が隣の列へ届かないことは誰も検査していなかったので、この
 * バグは見逃されていた。
 *
 * ここでは「描画後の幾何」を、実ブラウザに頼らず SVG 自体の仕様が保証する形で検査する。
 * SVG の `textLength` + `lengthAdjust="spacingAndGlyphs"` は、レンダラに対して実描画幅を
 * その値に強制するという仕様上の contract であり、これが付いているときは
 * 「x + textLength」がそのテキストの実際の右端になることをレンダラ非依存に断言できる。
 * 付いていないとき (= 安全に収まると判断された通常値) は、production の見積りとは別に
 * このテストが独自に持つ、より保守的な (production より広く見積もる) 概算式で
 * 「それでも次列へ届かない」ことを確認する。production 側の安全係数が将来ゆるめられて
 * 保護が抜けた場合、この独立した見積りが検出できるようにするため、あえて production の
 * NUMERIC_GLYPH_WIDTH_EM をここでは import せず、別の値で再実装している。
 *
 * 実際のブラウザでの見た目 (フォント differences 込み) は、この PR の検証時に Playwright +
 * Chromium で目視・実測済み (report 参照)。この test はその検証を置き換えるものではなく、
 * 将来 SCORE/RANK 桁数が変わっても同じ穴が再発しないことを継続的に保証するための
 * 決定論的な回帰テスト。
 */

const MIN_COLUMN_GUTTER_PX = 4;
// production (result-card.ts) の NUMERIC_GLYPH_WIDTH_EM (0.75) より意図的に太らせた、
// このテスト専用の独立した概算係数。production 側の安全係数が下がっても検出できるように。
const INDEPENDENT_GLYPH_WIDTH_EM = 0.85;

function leaderboard(overrides: Partial<LeaderboardResponse> = {}): LeaderboardResponse {
  return {
    eventId: "event-id",
    entries: [
      {
        rank: 2,
        teamId: "team-id",
        teamName: "Cloud Ninjas",
        score: 842,
        completedProblems: 4,
        totalProblems: 6,
        isMyTeam: true,
      },
    ],
    ...overrides,
  };
}

function renderSvgFor(
  score: number,
  rank: number,
  completedProblems = 1,
  totalProblems = 1,
): string {
  const result = buildResultCardModel({
    leaderboard: leaderboard({
      entries: [
        {
          ...leaderboard().entries[0],
          score,
          rank,
          completedProblems,
          totalProblems,
        },
      ],
    }),
    eventTitle: "TenkaCloud Battle",
    generatedAt: "2026-08-12T13:00:00.000Z",
    locale: "en",
  });
  if (!result.ok) throw result.error;
  return renderResultCardSvg(result.value);
}

interface ParsedValueText {
  readonly x: number;
  readonly fontSize: number;
  readonly textLength: number | undefined;
  readonly text: string;
}

// SCORE (fill #ffffff, y=445) / RANK (fill #d9f99d, y=435) / PROGRESS (fill #ffffff, y=421)
// の値 <text> 要素を、実際に描画される SVG 文字列から直接読み取る。座標をテスト側で
// 決め打ちにせず SVG の出力自体から取るので、意図したレイアウト変更 (列の x を動かす等)
// にはテストが追従し、"隣列との重なり" という不変条件だけを検査し続ける。
function parseValueText(svg: string, y: number, fill: string): ParsedValueText {
  const pattern = new RegExp(
    `<text x="(-?\\d+(?:\\.\\d+)?)" y="${y}" fill="${fill}" font-family="[^"]*" font-size="(\\d+(?:\\.\\d+)?)" font-weight="800"(?: textLength="(\\d+(?:\\.\\d+)?)" lengthAdjust="spacingAndGlyphs")?>([^<]*)`,
  );
  const match = svg.match(pattern);
  if (!match) {
    throw new Error(
      `could not find a y="${y}" fill="${fill}" value <text> element in the rendered SVG`,
    );
  }
  const [, x, fontSize, textLength, text] = match;
  return {
    x: Number(x),
    fontSize: Number(fontSize),
    textLength: textLength === undefined ? undefined : Number(textLength),
    text: text ?? "",
  };
}

function independentEstimatedWidth(parsed: ParsedValueText): number {
  return parsed.text.length * parsed.fontSize * INDEPENDENT_GLYPH_WIDTH_EM;
}

// SVG の textLength+lengthAdjust="spacingAndGlyphs" は「実描画幅をこの値に強制する」という
// SVG 仕様そのものの contract なので、付いているときは x + textLength がレンダラ非依存に
// 実際の右端になる。付いていないときだけ、このテスト独自の (production より保守的な) 概算を使う。
function rightEdge(parsed: ParsedValueText): number {
  return parsed.x + (parsed.textLength ?? independentEstimatedWidth(parsed));
}

function parseColumns(svg: string) {
  return {
    score: parseValueText(svg, 445, "#ffffff"),
    rank: parseValueText(svg, 435, "#d9f99d"),
    progress: parseValueText(svg, 421, "#ffffff"),
  };
}

describe("Result Card value column layout guarantees (#3066)", () => {
  it("keeps SCORE clear of RANK and RANK clear of PROGRESS for the reported extreme combination (rank 9999, 10-digit score, 999/1000)", () => {
    const svg = renderSvgFor(1234567890, 9999, 999, 1000);
    const { score, rank, progress } = parseColumns(svg);

    // このまさに報告された組み合わせでは、SCORE の自然な描画幅が列の上限を越えるはずなので、
    // textLength による強制収縮が実際に働いていることも明示的に確認する
    // (= "たまたま今回は収まっていた" ではなく、収縮メカニズムが発火したことの確認)。
    expect(score.textLength).toBeDefined();

    expect(rightEdge(score) + MIN_COLUMN_GUTTER_PX).toBeLessThanOrEqual(rank.x);
    expect(rightEdge(rank) + MIN_COLUMN_GUTTER_PX).toBeLessThanOrEqual(progress.x);
  });

  it("does not clamp SCORE/RANK for ordinary short values (no textLength attribute, unchanged look)", () => {
    const svg = renderSvgFor(842, 2);
    const { score, rank } = parseColumns(svg);
    expect(score.textLength).toBeUndefined();
    expect(rank.textLength).toBeUndefined();
  });

  it.each([
    [5, 3],
    [842, 2],
    [99999, 999],
    [123456, 12345],
    [1234567, 123456],
    [12345678, 1234],
    [123456789, 9999],
    [1234567890, 9999], // #3066 で報告された組み合わせ (score 10桁, rank 4桁)
    [-1234567890, 9999],
    [12345678901, 3],
    [1234567890123, 1],
    [Number.MAX_SAFE_INTEGER, 1], // score が safe integer の上限 (16桁)
    [-Number.MAX_SAFE_INTEGER, 1], // 符号付きで 17 文字
    [1, Number.MAX_SAFE_INTEGER], // score は小さく rank だけが極端に大きい逆パターン
  ] as const)("never overlaps SCORE/RANK/PROGRESS for score=%i, rank=%i", (score, rank) => {
    const svg = renderSvgFor(score, rank);
    const { score: scoreParsed, rank: rankParsed, progress: progressParsed } = parseColumns(svg);

    expect(rightEdge(scoreParsed) + MIN_COLUMN_GUTTER_PX).toBeLessThanOrEqual(rankParsed.x);
    expect(rightEdge(rankParsed) + MIN_COLUMN_GUTTER_PX).toBeLessThanOrEqual(progressParsed.x);
  });
});
