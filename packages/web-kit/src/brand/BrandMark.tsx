import type { CSSProperties, ReactElement } from "react";
import { BRAND_MARK_VIEWBOX, type BrandMarkVariant, MarkGeometry } from "./marks";

/**
 * `<BrandMark>` — TenkaCloud の再利用可能なロゴアイコン (単色 SVG)。
 *
 * 色は `currentColor` なので、親要素の `color` (Cloudscape の `text-*` token / `--tc-ink` /
 * 任意の CSS) を継ぐ。これで「白背景に ink」「ダーク背景に white」「accent 上に white」を
 * 1 つの component で賄える (= DESIGN-SYSTEM.html "13. Logo & brand mark")。
 *
 * - `title` を渡すと `role="img"` + `<title>` でアクセシブル名を付与。
 *   省略時は装飾扱い (`aria-hidden`) になり、隣接するテキストに意味づけを委ねる。
 * - サイズは正方形 (`width = height = size`)。viewBox 比率は固定。
 */
export interface BrandMarkProps {
  readonly variant?: BrandMarkVariant;
  readonly size?: number | string;
  readonly title?: string;
  readonly className?: string;
  readonly style?: CSSProperties;
}

export function BrandMark({
  variant = "summit",
  size = 24,
  title,
  className,
  style,
}: BrandMarkProps): ReactElement {
  const shared = {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: BRAND_MARK_VIEWBOX,
    width: size,
    height: size,
    className,
    style,
    focusable: false as const,
  };
  // title 指定時は role="img" + aria-label でアクセシブル名を与える。省略時は装飾扱い
  // (aria-hidden) にし、隣接テキストに意味づけを委ねる。両分岐とも a11y 属性は静的に確定させる。
  if (title !== undefined) {
    return (
      <svg {...shared} role="img" aria-label={title}>
        <MarkGeometry variant={variant} />
      </svg>
    );
  }
  return (
    <svg {...shared} aria-hidden="true">
      <MarkGeometry variant={variant} />
    </svg>
  );
}
