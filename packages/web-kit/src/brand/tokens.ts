/**
 * TenkaCloud ブランドトークン (Claude Design "Logo system" v1)。
 *
 * これは「ブランド」の正本で、Cloudscape の機能色トークン (DESIGN-SYSTEM.html "4. Color tokens")
 * とは別レイヤー。ロゴ / favicon / landing など Cloudscape の外で色を使う面はここを参照する。
 * 同じ値を CSS custom properties として `brand.css` が `--tc-*` で公開するので、両者は一致させること。
 *
 * 基本はインク 1 色。`accent` は商標登録時の「結合の自由度」を保つためロゴ本体には常用しない差し色。
 */
export const brandColors = {
  ink: "#1d1d1f",
  ink2: "#424245",
  ink3: "#6e6e73",
  ink4: "#86868b",
  line: "#d2d2d7",
  lineSoft: "#e8e8ed",
  paper: "#ffffff",
  paper2: "#fbfbfd",
  paper3: "#f5f5f7",
  accent: "#ff6a32",
} as const;
