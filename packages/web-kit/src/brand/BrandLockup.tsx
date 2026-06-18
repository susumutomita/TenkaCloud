import type { CSSProperties, ReactElement, ReactNode } from "react";
import { BrandMark } from "./BrandMark";
import type { BrandMarkVariant } from "./marks";

/**
 * `<BrandLockup>` — マーク + ワードマークの基本ロックアップ (横組み / 縦組み)。
 *
 * ワードマークは既定で `Tenka` (ink) + `Cloud` (muted) の 2 トーン。`wordmark` prop で
 * 日本語表記 (`天下クラウド`) などに差し替えられる。マーク自体は装飾扱いにし、ロックアップ全体に
 * `role="img"` + `aria-label` を 1 つだけ付けてアクセシブル名の重複を避ける。
 *
 * 色 / フォントは `--tc-*` ブランドトークン (brand.css) を参照し、未定義環境向けに値を fallback。
 * Cloudscape に依存しないので landing / docs / SPA いずれでも使える。
 */
export type BrandLockupOrientation = "horizontal" | "vertical";

export interface BrandLockupProps {
  readonly variant?: BrandMarkVariant;
  readonly orientation?: BrandLockupOrientation;
  readonly markSize?: number | string;
  readonly fontSize?: number | string;
  readonly wordmark?: ReactNode;
  readonly title?: string;
  readonly className?: string;
  readonly style?: CSSProperties;
}

const DEFAULT_WORDMARK: ReactNode = (
  <>
    Tenka<span style={{ color: "var(--tc-ink-3, #6e6e73)" }}>Cloud</span>
  </>
);

export function BrandLockup({
  variant = "summit",
  orientation = "horizontal",
  markSize = 28,
  fontSize = 20,
  wordmark = DEFAULT_WORDMARK,
  title = "TenkaCloud",
  className,
  style,
}: BrandLockupProps): ReactElement {
  const vertical = orientation === "vertical";
  return (
    <span
      role="img"
      aria-label={title}
      className={className}
      style={{
        display: "inline-flex",
        flexDirection: vertical ? "column" : "row",
        alignItems: "center",
        gap: vertical ? "0.5em" : "0.55em",
        color: "var(--tc-ink, #1d1d1f)",
        fontFamily:
          'var(--tc-font-sans, "Inter", "Noto Sans JP", -apple-system, BlinkMacSystemFont, system-ui, sans-serif)',
        fontWeight: 600,
        letterSpacing: "-0.03em",
        lineHeight: 1,
        ...style,
      }}
    >
      <BrandMark variant={variant} size={markSize} />
      <span aria-hidden="true" style={{ fontSize }}>
        {wordmark}
      </span>
    </span>
  );
}
