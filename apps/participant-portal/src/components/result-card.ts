import type { LeaderboardResponse } from "../api/portal-client";

/**
 * Issue #3035: authoritative Leaderboard snapshot から共有画像を組み立てる pure domain。
 *
 * Public model は allowlist 方式で teamId / eventId / login key / deployment metadata を
 * 持てない shape に固定する。SVG は外部画像・外部 font・DOM screenshot に依存せず、同じ
 * model から同じ 1200 x 630 output を生成する。PNG rasterize だけを browser adapter 境界に置く。
 */

const RESULT_CARD_WIDTH = 1200;
const RESULT_CARD_HEIGHT = 630;

export type ResultCardLocale = "ja" | "en";
export type ResultCardStatus = "live" | "final";

export type ResultCardErrorCode =
  | "scoreboard-frozen"
  | "missing-event-title"
  | "missing-own-team"
  | "missing-team-name"
  | "ambiguous-own-team"
  | "invalid-generated-at"
  | "invalid-rank"
  | "invalid-score"
  | "invalid-progress"
  | "browser-unavailable"
  | "image-decode-failed"
  | "canvas-context-unavailable"
  | "canvas-render-failed"
  | "png-encoding-failed";

export class ResultCardError extends Error {
  public readonly code: ResultCardErrorCode;
  public readonly cause?: unknown;

  public constructor(code: ResultCardErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "ResultCardError";
    this.code = code;
    this.cause = cause;
  }
}

export type ResultCardResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ResultCardError };

export interface ResultCardModel {
  readonly eventTitle: string;
  readonly teamName: string;
  readonly rank: number;
  readonly score: number;
  readonly completedProblems: number;
  readonly totalProblems: number;
  readonly status: ResultCardStatus;
  readonly generatedAt: string;
  readonly locale: ResultCardLocale;
}

interface BuildResultCardModelInput {
  readonly leaderboard: LeaderboardResponse;
  readonly eventTitle: string;
  readonly generatedAt: string;
  readonly locale: ResultCardLocale;
}

export interface ResultCardBrowserAdapters {
  readonly createImage: () => HTMLImageElement;
  readonly createCanvas: (width: number, height: number) => HTMLCanvasElement;
}

const SVG_FONT_FAMILY =
  "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Yu Gothic', 'Noto Sans JP', 'Noto Sans CJK JP', 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif";
const BIDI_CONTROL_CHARACTERS = /[\u202a-\u202e\u2066-\u2069]/gu;

const CARD_LABELS = {
  ja: {
    statusLive: "LIVE RESULT",
    statusFinal: "FINAL RESULT",
    rank: "順位",
    score: "スコア",
    progress: "完了",
    generated: "生成",
  },
  en: {
    statusLive: "LIVE RESULT",
    statusFinal: "FINAL RESULT",
    rank: "RANK",
    score: "SCORE",
    progress: "PROGRESS",
    generated: "GENERATED",
  },
} as const satisfies Record<ResultCardLocale, Record<string, string>>;

function fail<T>(code: ResultCardErrorCode, message: string, cause?: unknown): ResultCardResult<T> {
  return { ok: false, error: new ResultCardError(code, message, cause) };
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function replaceLoneSurrogates(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // index/index+1 はどちらも文字列長の範囲内が確定しているため ?? 右辺は
        // noUncheckedIndexedAccess 対応のみの不到達分岐。
        /* v8 ignore next */
        output += value[index] ?? "";
        /* v8 ignore next */
        output += value[index + 1] ?? "";
        index += 1;
      } else {
        output += "�";
      }
      continue;
    }
    if (current >= 0xdc00 && current <= 0xdfff) {
      output += "�";
      continue;
    }
    // index はループ範囲内が確定しているため ?? 右辺は noUncheckedIndexedAccess
    // 対応のみの不到達分岐。
    /* v8 ignore next */
    output += value[index] ?? "";
  }
  return output;
}

function isInvalidXmlCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0 && codePoint <= 8) ||
    codePoint === 11 ||
    codePoint === 12 ||
    (codePoint >= 14 && codePoint <= 31) ||
    codePoint === 127 ||
    codePoint === 0xfffe ||
    codePoint === 0xffff
  );
}

function stripInvalidXmlCharacters(value: string): string {
  return Array.from(value)
    .filter(
      (character) =>
        // Array.from(value) の各要素は非空の 1 コードポイントが確定しているため
        // ?? 右辺は不到達分岐。
        /* v8 ignore next */
        !isInvalidXmlCodePoint(character.codePointAt(0) ?? 0),
    )
    .join("");
}

function normalizeDisplayText(value: string, maximumCodePoints: number): string {
  const normalized = stripInvalidXmlCharacters(replaceLoneSurrogates(value).normalize("NFC"))
    .replace(BIDI_CONTROL_CHARACTERS, "")
    .replace(/\s+/gu, " ")
    .trim();
  return truncateCodePoints(normalized, maximumCodePoints);
}

export function truncateCodePoints(value: string, maximumCodePoints: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= maximumCodePoints) return value;
  if (maximumCodePoints <= 1) return "…";
  return `${codePoints.slice(0, maximumCodePoints - 1).join("")}…`;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function parseTimestamp(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function buildResultCardModel(
  input: BuildResultCardModelInput,
): ResultCardResult<ResultCardModel> {
  if (input.leaderboard.scoreboardFrozen === true) {
    return fail("scoreboard-frozen", "A result card cannot be created while scores are frozen.");
  }

  const eventTitle = normalizeDisplayText(input.eventTitle, 96);
  if (!eventTitle) {
    return fail("missing-event-title", "The event title is required.");
  }

  const generatedAtMs = parseTimestamp(input.generatedAt);
  if (generatedAtMs === undefined) {
    return fail("invalid-generated-at", "generatedAt must be a valid timestamp.");
  }

  const ownEntries = input.leaderboard.entries.filter((entry) => entry.isMyTeam);
  if (ownEntries.length === 0) {
    return fail("missing-own-team", "The leaderboard does not contain the current team.");
  }
  if (ownEntries.length > 1) {
    return fail("ambiguous-own-team", "The leaderboard contains more than one current team entry.");
  }

  const ownEntry = ownEntries[0];
  if (!ownEntry || !Number.isSafeInteger(ownEntry.rank) || ownEntry.rank < 1) {
    return fail("invalid-rank", "The team rank must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(ownEntry.score)) {
    return fail("invalid-score", "The team score must be a safe integer.");
  }
  if (
    !isNonNegativeSafeInteger(ownEntry.completedProblems) ||
    !isNonNegativeSafeInteger(ownEntry.totalProblems) ||
    ownEntry.completedProblems > ownEntry.totalProblems
  ) {
    return fail("invalid-progress", "The team progress is invalid.");
  }

  const teamName = normalizeDisplayText(ownEntry.teamName, 48);
  if (!teamName) {
    return fail("missing-team-name", "The team display name is required.");
  }
  const endsAtMs = input.leaderboard.endsAt ? parseTimestamp(input.leaderboard.endsAt) : undefined;
  const status: ResultCardStatus =
    endsAtMs !== undefined && generatedAtMs >= endsAtMs ? "final" : "live";

  return {
    ok: true,
    value: {
      eventTitle,
      teamName,
      rank: ownEntry.rank,
      score: ownEntry.score,
      completedProblems: ownEntry.completedProblems,
      totalProblems: ownEntry.totalProblems,
      status,
      generatedAt: new Date(generatedAtMs).toISOString(),
      locale: input.locale,
    },
  };
}

// #3066: SCORE (x=60) と RANK (x=570) の値テキストは、それぞれの font-size を桁数だけから
// 独立に選んでいた。rank が 4 桁かつ score が 10 桁のように両方が同時に長くなる組み合わせ
// では、選んだ font-size のままでも自然な描画幅が次の列の開始位置を越えて SCORE と RANK
// (あるいは RANK と PROGRESS) が重なる。font-size をさらに細かく場合分けするのではなく、
// 各列に「これを超えない」という幅の上限を持たせ、越えるときだけ SVG の
// textLength/lengthAdjust="spacingAndGlyphs" で実描画幅をその上限に強制収縮する
// (収まっている通常値ではこの属性を付けず、既存の見た目を変えない)。
const SCORE_COLUMN_X = 60;
const SCORE_COLUMN_MAX_WIDTH = 460; // 次列 RANK (x=570) との間隔 510px から余白 50px を引いた値。
const RANK_COLUMN_X = 570;
const RANK_COLUMN_MAX_WIDTH = 260; // 次列 PROGRESS (x=880) との間隔 310px から余白 50px を引いた値。

// SCORE/RANK は数字と '#' / '-' のみで構成される。実際のグリフ幅は描画環境のフォントに
// 依存し、この pure function からは測定できないため、「越えそうなら安全側 (収縮する) に
// 倒す」ように意図的に太らせた係数を使う (result-card.test.ts の Playwright geometry 回帰
// テストで、実際に Chromium が描画した bounding box が重ならないことを検証している)。
const NUMERIC_GLYPH_WIDTH_EM = 0.75;

function estimateNumericTextWidth(text: string, fontSizePx: number): number {
  return text.length * fontSizePx * NUMERIC_GLYPH_WIDTH_EM;
}

// text が maxWidth に収まりそうにないときだけ、その幅へ強制収縮する SVG 属性を返す。
// 収まりそうなときは空文字 (= 属性を付けない、通常の自然な描画幅のまま)。
function widthClampAttributes(text: string, fontSizePx: number, maxWidth: number): string {
  if (estimateNumericTextWidth(text, fontSizePx) <= maxWidth) return "";
  return ` textLength="${maxWidth}" lengthAdjust="spacingAndGlyphs"`;
}

function scoreFontSize(score: number): number {
  const digits = String(score).length;
  if (digits <= 5) return 124;
  if (digits <= 7) return 104;
  if (digits <= 10) return 84;
  return 68;
}

function rankFontSize(rank: number): number {
  const digits = String(rank).length;
  if (digits <= 3) return 104;
  if (digits <= 5) return 84;
  return 64;
}

function eventTitleFontSize(value: string): number {
  const length = Array.from(value).length;
  if (length <= 30) return 27;
  if (length <= 38) return 24;
  return 22;
}

function teamNameFontSize(value: string): number {
  const length = Array.from(value).length;
  if (length <= 20) return 52;
  if (length <= 24) return 44;
  return 38;
}

function formatGeneratedAt(value: string): string {
  return value.replace("T", " ").replace(/:\d{2}\.\d{3}Z$/u, " UTC");
}

function buildResultCardAltText(model: ResultCardModel): string {
  if (model.locale === "ja") {
    return (
      `${model.eventTitle}、${model.teamName}、順位 ${model.rank} 位、` +
      `${model.score} 点、${model.completedProblems}/${model.totalProblems} 問完了`
    );
  }
  return (
    `${model.eventTitle}, ${model.teamName}, rank ${model.rank}, ${model.score} points, ` +
    `${model.completedProblems} of ${model.totalProblems} problems completed`
  );
}

export function renderResultCardSvg(model: ResultCardModel): string {
  const labels = CARD_LABELS[model.locale];
  const eventTitleText = truncateCodePoints(model.eventTitle, 44);
  const teamNameText = truncateCodePoints(model.teamName, 28);
  const eventTitle = escapeXml(eventTitleText);
  const teamName = escapeXml(teamNameText);
  const statusLabel = model.status === "final" ? labels.statusFinal : labels.statusLive;
  const progressRatio =
    model.totalProblems === 0 ? 0 : model.completedProblems / model.totalProblems;
  const progressWidth = Math.round(1060 * Math.min(1, Math.max(0, progressRatio)));
  const generatedAt = escapeXml(formatGeneratedAt(model.generatedAt));
  const accessibleTitle = escapeXml(buildResultCardAltText(model));

  // #3066: SCORE/RANK は値そのもの (escapeXml 不要な数字と '#' / '-' のみ) を幅の制約対象
  // にする。桁数から選んだ font-size のままで列の最大幅を越えそうなときだけ、実描画幅を
  // その列の最大幅に強制収縮する属性を付ける。
  const scoreText = String(model.score);
  const scoreFontSizePx = scoreFontSize(model.score);
  const scoreWidthAttrs = widthClampAttributes(scoreText, scoreFontSizePx, SCORE_COLUMN_MAX_WIDTH);
  const rankText = `#${model.rank}`;
  const rankFontSizePx = rankFontSize(model.rank);
  const rankWidthAttrs = widthClampAttributes(rankText, rankFontSizePx, RANK_COLUMN_MAX_WIDTH);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RESULT_CARD_WIDTH}" height="${RESULT_CARD_HEIGHT}" viewBox="0 0 ${RESULT_CARD_WIDTH} ${RESULT_CARD_HEIGHT}" role="img" aria-labelledby="title">
  <title id="title">${accessibleTitle}</title>
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#07111f"/>
      <stop offset="0.58" stop-color="#0c2440"/>
      <stop offset="1" stop-color="#12365a"/>
    </linearGradient>
    <linearGradient id="progress" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#4fd1c5"/>
      <stop offset="1" stop-color="#67e8f9"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" rx="32" fill="url(#background)"/>
  <circle cx="1070" cy="40" r="250" fill="#2dd4bf" opacity="0.08"/>
  <circle cx="1120" cy="600" r="190" fill="#38bdf8" opacity="0.08"/>
  <rect x="56" y="48" width="238" height="50" rx="25" fill="#ffffff" opacity="0.1"/>
  <text x="78" y="82" fill="#e6f7ff" font-family="${SVG_FONT_FAMILY}" font-size="25" font-weight="700" letter-spacing="1.5">TENKACLOUD</text>
  <rect x="930" y="48" width="214" height="50" rx="25" fill="#0f766e" opacity="0.95"/>
  <text x="1037" y="81" text-anchor="middle" fill="#ecfeff" font-family="${SVG_FONT_FAMILY}" font-size="20" font-weight="800" letter-spacing="1.2">${statusLabel}</text>
  <text x="60" y="158" fill="#9bd8f4" font-family="${SVG_FONT_FAMILY}" font-size="${eventTitleFontSize(eventTitleText)}" font-weight="600">${eventTitle}</text>
  <text x="60" y="226" fill="#ffffff" font-family="${SVG_FONT_FAMILY}" font-size="${teamNameFontSize(teamNameText)}" font-weight="800">${teamName}</text>
  <line x1="60" y1="268" x2="1140" y2="268" stroke="#d6f1ff" stroke-opacity="0.18"/>
  <text x="60" y="330" fill="#89b9d4" font-family="${SVG_FONT_FAMILY}" font-size="22" font-weight="700" letter-spacing="1">${labels.score}</text>
  <text x="${SCORE_COLUMN_X}" y="445" fill="#ffffff" font-family="${SVG_FONT_FAMILY}" font-size="${scoreFontSizePx}" font-weight="800"${scoreWidthAttrs}>${scoreText}</text>
  <text x="570" y="330" fill="#89b9d4" font-family="${SVG_FONT_FAMILY}" font-size="22" font-weight="700" letter-spacing="1">${labels.rank}</text>
  <text x="${RANK_COLUMN_X}" y="435" fill="#d9f99d" font-family="${SVG_FONT_FAMILY}" font-size="${rankFontSizePx}" font-weight="800"${rankWidthAttrs}>${rankText}</text>
  <text x="880" y="330" fill="#89b9d4" font-family="${SVG_FONT_FAMILY}" font-size="22" font-weight="700" letter-spacing="1">${labels.progress}</text>
  <text x="880" y="421" fill="#ffffff" font-family="${SVG_FONT_FAMILY}" font-size="72" font-weight="800">${model.completedProblems}<tspan fill="#7fb4cf" font-size="38"> / ${model.totalProblems}</tspan></text>
  <rect x="60" y="500" width="1060" height="18" rx="9" fill="#ffffff" opacity="0.13"/>
  <rect x="60" y="500" width="${progressWidth}" height="18" rx="9" fill="url(#progress)"/>
  <text x="60" y="575" fill="#7fb4cf" font-family="${SVG_FONT_FAMILY}" font-size="19" font-weight="600">${labels.generated}: ${generatedAt}</text>
  <text x="1140" y="575" text-anchor="end" fill="#b8e5f7" font-family="${SVG_FONT_FAMILY}" font-size="21" font-weight="700">Learn · Play · Prove</text>
</svg>`;
}

export function resultCardSvgDataUrl(model: ResultCardModel): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderResultCardSvg(model))}`;
}

function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start += 1;
  while (end > start && value[end - 1] === "-") end -= 1;
  return value.slice(start, end);
}

export function buildResultCardFilename(model: ResultCardModel): string {
  const normalizedTeamName = model.teamName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-");
  const slug = trimHyphens(normalizedTeamName).slice(0, 48);
  const timestamp = model.generatedAt.replace(/[-:]/gu, "").replace(/\.\d{3}/u, "");
  return `tenkacloud-${slug || "team"}-${model.status}-${timestamp}.png`;
}

function defaultBrowserAdapters(): ResultCardBrowserAdapters | undefined {
  // document/Image がこのモジュールから見えるかは、同じ worker で先に走った他の
  // test file に依存して変わる (実測して確認済みの環境レース)。この early-return
  // 側は Image を明示的に undefined へ固定して決定的にテストしている。その先
  // (実際に adapters を返す側) は、レースが「見える」側に倒れた場合にだけ real
  // browser と同じ経路を通る、この test 環境では固定できない分岐。
  /* v8 ignore else */
  if (typeof document === "undefined" || typeof Image === "undefined") return undefined;
  /* v8 ignore start */
  return {
    createImage: () => new Image(),
    createCanvas: (width, height) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    },
  };
  /* v8 ignore stop */
}

async function loadImage(image: HTMLImageElement, source: string): Promise<void> {
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = (event) => reject(event);
  });
  image.decoding = "async";
  image.src = source;

  if (typeof image.decode !== "function") {
    await loaded;
    return;
  }

  try {
    await image.decode();
  } catch (error) {
    if (image.complete && image.naturalWidth > 0) return;
    try {
      await loaded;
    } catch {
      throw error;
    }
  }
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new ResultCardError("png-encoding-failed", "Canvas returned an empty PNG blob."));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

export async function renderResultCardPng(
  model: ResultCardModel,
  browserAdapters: ResultCardBrowserAdapters | undefined = defaultBrowserAdapters(),
): Promise<ResultCardResult<Blob>> {
  if (!browserAdapters) {
    return fail("browser-unavailable", "Result card rendering requires a browser environment.");
  }

  let image: HTMLImageElement;
  try {
    image = browserAdapters.createImage();
    await loadImage(image, resultCardSvgDataUrl(model));
  } catch (error) {
    return fail("image-decode-failed", "The SVG preview could not be decoded.", error);
  }

  let canvas: HTMLCanvasElement;
  let context: CanvasRenderingContext2D | null;
  try {
    canvas = browserAdapters.createCanvas(RESULT_CARD_WIDTH, RESULT_CARD_HEIGHT);
    context = canvas.getContext("2d");
  } catch (error) {
    return fail(
      "canvas-context-unavailable",
      "The browser could not create a 2D canvas context.",
      error,
    );
  }
  if (!context) {
    return fail("canvas-context-unavailable", "The browser did not provide a 2D canvas context.");
  }

  try {
    context.clearRect(0, 0, RESULT_CARD_WIDTH, RESULT_CARD_HEIGHT);
    context.drawImage(image, 0, 0, RESULT_CARD_WIDTH, RESULT_CARD_HEIGHT);
  } catch (error) {
    return fail("canvas-render-failed", "The SVG preview could not be drawn to canvas.", error);
  }

  try {
    return { ok: true, value: await canvasToPngBlob(canvas) };
  } catch (error) {
    return error instanceof ResultCardError
      ? { ok: false, error }
      : fail("png-encoding-failed", "The PNG could not be encoded.", error);
  }
}
