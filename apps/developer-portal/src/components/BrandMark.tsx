import type { CSSProperties } from "react";

// TenkaCloud brand mark (single-color, currentColor) for the marketing surface.
// Geometry mirrors the canonical `summit` variant in @tenkacloud/web-kit
// (packages/web-kit/src/brand/marks.tsx): the "天" top bar + the ridge climbing to
// a peak. It is inlined rather than imported because web-kit's only export pulls in
// Cloudscape (a peer dependency the Next.js static portal does not carry). Keep the
// path constants in sync with web-kit if the brand mark ever changes.
const SUMMIT_BAR = { x: 26, y: 24, width: 68, height: 12, rx: 6 } as const;
const SUMMIT_RIDGE_PATH = "M26 90 L60 48 L94 90";
const SUMMIT_STROKE_WIDTH = 13;

export interface BrandMarkProps {
  readonly size?: number | string;
  readonly title?: string;
  readonly className?: string;
  readonly style?: CSSProperties;
}

export function BrandMark({ size = 24, title, className, style }: BrandMarkProps) {
  const shared = {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: "0 0 120 120",
    width: size,
    height: size,
    className,
    style,
    focusable: false as const,
  };
  const geometry = (
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
  if (title !== undefined) {
    return (
      <svg {...shared} role="img" aria-label={title}>
        {geometry}
      </svg>
    );
  }
  return (
    <svg {...shared} aria-hidden="true">
      {geometry}
    </svg>
  );
}
