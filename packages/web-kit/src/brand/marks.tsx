import type { ReactElement } from "react";

/**
 * TenkaCloud ブランドマークの幾何データ — 単一の正本 (Claude Design "Logo system" v1)。
 *
 * 3 案いずれも `viewBox 0 0 120 120` / 単色 (`currentColor`) / 幾何ベースで、極小サイズでも
 * 崩れず商標として識別性が高い。推奨は `summit`。
 *
 * - `summit`    — 漢字「天」の上線 + 頂上へ伸びる稜線。天下＝頂点を獲る意味と「登りつめる」競技性を 1 形に。
 * - `ascend`    — 積み重なる山形 = 階級章 / 昇格。ランクが上がるゲーム性をストレートに表現。
 * - `cloudpeak` — 雲 (クラウド) の上に頂が突き抜ける構図。プロダクトの「クラウド」を最も直接的に示す。
 *
 * SVG ファイルや data URI に展開する側も、この path 定数を import して drift を防ぐこと。
 */
export type BrandMarkVariant = "summit" | "ascend" | "cloudpeak";

export const BRAND_MARK_VARIANTS = [
  "summit",
  "ascend",
  "cloudpeak",
] as const satisfies readonly BrandMarkVariant[];

export const BRAND_MARK_VIEWBOX = "0 0 120 120";

/** summit — 「天」の上線 (横棒) */
export const SUMMIT_BAR = { x: 34, y: 24, width: 52, height: 12, rx: 6 } as const;
/** summit — 頂への稜線 */
export const SUMMIT_RIDGE_PATH = "M26 90 L60 46 L94 90";
export const SUMMIT_STROKE_WIDTH = 13;

/** ascend — 上段 / 下段の山形 (下段は薄く重ねる) */
export const ASCEND_TOP_PATH = "M30 56 L60 30 L90 56";
export const ASCEND_BOTTOM_PATH = "M30 90 L60 64 L90 90";
export const ASCEND_STROKE_WIDTH = 12;
export const ASCEND_BOTTOM_OPACITY = 0.55;

/** cloudpeak — 突き抜ける頂 + その土台になる雲 */
export const CLOUDPEAK_PEAK_PATH = "M42 64 L60 32 L78 64 Z";
export const CLOUDPEAK_CLOUD_PATH =
  "M30 74 a14 14 0 0 1 4 -27 a18 18 0 0 1 35 -3 a15 15 0 0 1 22 8 a13 13 0 0 1 -2 25 Z";
export const CLOUDPEAK_CLOUD_OPACITY = 0.32;

/**
 * `<svg viewBox="0 0 120 120">` の子要素 (= マーク本体の幾何) を返す。色は `currentColor`
 * に委ねるので、親が `color` を指定すれば追従する。`BrandMark` から呼ばれる内部 helper。
 */
export function MarkGeometry({ variant }: { readonly variant: BrandMarkVariant }): ReactElement {
  switch (variant) {
    case "ascend":
      return (
        <>
          <path
            d={ASCEND_TOP_PATH}
            fill="none"
            stroke="currentColor"
            strokeWidth={ASCEND_STROKE_WIDTH}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={ASCEND_BOTTOM_PATH}
            fill="none"
            stroke="currentColor"
            strokeWidth={ASCEND_STROKE_WIDTH}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={ASCEND_BOTTOM_OPACITY}
          />
        </>
      );
    case "cloudpeak":
      return (
        <>
          <path d={CLOUDPEAK_CLOUD_PATH} fill="currentColor" opacity={CLOUDPEAK_CLOUD_OPACITY} />
          <path d={CLOUDPEAK_PEAK_PATH} fill="currentColor" />
        </>
      );
    default:
      return (
        <>
          <rect
            x={SUMMIT_BAR.x}
            y={SUMMIT_BAR.y}
            width={SUMMIT_BAR.width}
            height={SUMMIT_BAR.height}
            rx={SUMMIT_BAR.rx}
            fill="currentColor"
          />
          <path
            d={SUMMIT_RIDGE_PATH}
            fill="none"
            stroke="currentColor"
            strokeWidth={SUMMIT_STROKE_WIDTH}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
  }
}
