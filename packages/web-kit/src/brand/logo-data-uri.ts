import { SUMMIT_BAR, SUMMIT_RIDGE_PATH, SUMMIT_STROKE_WIDTH } from "./marks";
import { brandColors } from "./tokens";

/**
 * `<img src>` / Cloudscape `TopNavigation` の `identity.logo.src` 向けロゴ。
 *
 * `<img>` は `currentColor` を継げないので、ここでは色を焼き込んだ SVG を data URI 化する。
 * `BrandMark` (React) と同じ summit path 定数から組み立て、コードとロゴの drift を防ぐ。
 */

function summitInner(color: string): string {
  const { x, y, width, height, rx } = SUMMIT_BAR;
  return (
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" fill="${color}"/>` +
    `<path d="${SUMMIT_RIDGE_PATH}" fill="none" stroke="${color}" stroke-width="${SUMMIT_STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round"/>`
  );
}

function toDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** 透過背景 + ink の summit マーク。明るい面に置く単色ロゴ用。 */
export const tenkaCloudMarkSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">${summitInner(
  brandColors.ink,
)}</svg>`;

/**
 * 角丸 (iOS 流の ~22%) の app icon: ink 背景 + white summit。背景を持つので、明暗どちらの
 * ヘッダー上でも安定して読める。SPA の TopNavigation ロゴはこれを使う。
 */
export const tenkaCloudAppIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="26" fill="${
  brandColors.ink
}"/>${summitInner(brandColors.paper)}</svg>`;

export const tenkaCloudMarkDataUri = toDataUri(tenkaCloudMarkSvg);
export const tenkaCloudAppIconDataUri = toDataUri(tenkaCloudAppIconSvg);
