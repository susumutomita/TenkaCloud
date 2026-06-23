import type { CfnManagedLoginBranding } from "aws-cdk-lib/aws-cognito";

/**
 * Issue #1990 epic / #1991 (tenant) + #1992 (control plane): Cognito **Managed login (v2)**
 * の ink ブランディングを両 plane で共有するヘルパ。
 *
 * classic Hosted UI は `*-customizable` allowlist の制約で design import「Cognito Hosted UI.html」
 * を再現できず deploy 後に画面が崩れた (#1987 / #1989)。 Managed login はブランディングデザイナー
 * 世代の UI で、 色トークン / rounded corner / ロゴ画像をコード指定できる。
 *
 * # 設計方針: 最小の partial settings + merge
 *
 * `CfnManagedLoginBranding.settings` は free-form JSON Document で、 Cognito は
 * **指定しなかったトークンを既定値のまま保持する** (= partial settings は valid)。
 * AWS の CreateManagedLoginBranding API リファレンス:
 *   "Amazon Cognito doesn't require that you pass all parameters in one request and
 *    preserves existing style settings that you don't specify."
 * よって巨大な full settings document を手書きせず、 ink テーマに必要な **ブランドトークンだけ**
 * を上書きする。 これにより Cognito 既定の component schema (input / link / alert 等) を壊さず、
 * SDK / console branding editor の世代差にも追従しやすい (merge-friendly)。
 *
 * # ink テーマ (TenkaCloud brand `packages/web-kit/src/brand/tokens.ts` と一致)
 *   - page background = ink #1d1d1f (= `brandColors.ink`)。 page text は light に倒す。
 *   - form card = white #ffffff、 border は brand line #d2d2d7。
 *   - primary "Sign in" button = ink background + white text (active/hover も ink 系)。
 *   - FORM_LOGO = Summit マーク (白カード上に出すので **ink マーク**)。
 *
 * Cognito の色トークンは 8 桁 hex (RGBA、 末尾 `ff` = 不透明)。
 *
 * `useCognitoProvidedValues` と `settings`/`assets` は **排他**。 custom settings/assets を渡す
 * ときは `useCognitoProvidedValues` を **省略** しなければならない (API 制約)。
 *
 * pixel 一致は Cognito console の branding editor で微調整する前提 (#1990 cross-cutting)。
 * 本ヘルパは ink テーマ + Summit ロゴをコード経路で確実に投入する。
 */

/** TenkaCloud brand tokens を Cognito の 8 桁 hex (RGBA) で表現したもの (`tokens.ts` と一致)。 */
const INK = "1d1d1fff"; // brandColors.ink #1d1d1f
const INK_HOVER = "424245ff"; // brandColors.ink2 #424245 (button hover / active の僅かな差)
const PAPER = "ffffffff"; // brandColors.paper #ffffff (white card / button text)
const LINE = "d2d2d7ff"; // brandColors.line #d2d2d7 (card border)
const PAPER_TEXT = "f5f5f7ff"; // brandColors.paper3 #f5f5f7 (ink 背景上の本文を読めるよう light に)
const INK3 = "6e6e73ff"; // brandColors.ink3 #6e6e73 (white card 上の説明テキスト)

/**
 * Summit マーク (`packages/web-kit/src/brand/assets/tenkacloud-mark.svg`、 ink グリフ) の
 * base64。 form logo は **白カードの上**に出るため ink マークを使う。
 *
 * Bytes は CFn で Base64-encoded binary 文字列を要求する (AssetType.Bytes、 最大 1,000,000)。
 * SVG は ~280 バイトと極小なので inline で持つ (= deploy 時の追加 asset 不要、 cost-zero)。
 */
const SUMMIT_MARK_INK_SVG_BASE64 =
  "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjAgMTIwIiB3aWR0aD0iMTIwIiBoZWlnaHQ9IjEyMCI+CiAgPHJlY3QgeD0iMjYiIHk9IjI0IiB3aWR0aD0iNjgiIGhlaWdodD0iMTIiIHJ4PSI2IiBmaWxsPSIjMWQxZDFmIj48L3JlY3Q+CiAgPHBhdGggZD0iTTI2IDkwIEw2MCA0OCBMOTQgOTAiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzFkMWQxZiIgc3Ryb2tlLXdpZHRoPSIxMyIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48L3BhdGg+Cjwvc3ZnPgo=";

/**
 * ink テーマの partial settings (Cognito 既定値に merge される)。
 *
 * `colorSchemeMode: LIGHT` で white card レイアウトに固定し、 light mode の brand トークン
 * だけを上書きする。 ここに無いトークン (input / link / status indicator 等) は Cognito 既定の
 * まま保持される。
 */
export function buildInkManagedLoginSettings(): Record<string, unknown> {
  return {
    categories: {
      // white カードレイアウトに固定 (ink テーマは light mode をベースに page bg を ink にする)。
      global: {
        colorSchemeMode: "LIGHT",
      },
      // ロゴはフォーム内 (= white カード上) に出す。
      form: {
        displayGraphics: true,
      },
    },
    componentClasses: {
      // ボタン角丸 (brand の rounded UI に合わせる)。
      buttons: {
        borderRadius: 8.0,
      },
      // white カード上の入力欄サブテキストを ink3 に。 inputDescription は componentClasses 配下が正
      // (components 配下に置くと UnknownProperty で managed login の deploy が UPDATE_FAILED になる)。
      inputDescription: {
        lightMode: {
          textColor: INK3,
        },
      },
    },
    components: {
      // ページ背景を ink アクセントに。
      pageBackground: {
        lightMode: {
          color: INK,
        },
      },
      // ink 背景上の見出し / 本文 / 説明を読めるよう light 寄りに。
      pageText: {
        lightMode: {
          bodyColor: PAPER_TEXT,
          descriptionColor: PAPER_TEXT,
          headingColor: PAPER,
        },
      },
      // 認証フォームは white カード + brand line のボーダー。 ロゴをカード上部中央に出す。
      form: {
        lightMode: {
          backgroundColor: PAPER,
          borderColor: LINE,
        },
        logo: {
          enabled: true,
          formInclusion: "IN",
          location: "CENTER",
          position: "TOP",
        },
      },
      // primary "Sign in" ボタン = ink background + white text。
      primaryButton: {
        lightMode: {
          defaults: {
            backgroundColor: INK,
            textColor: PAPER,
          },
          hover: {
            backgroundColor: INK_HOVER,
            textColor: PAPER,
          },
          active: {
            backgroundColor: INK_HOVER,
            textColor: PAPER,
          },
        },
      },
      // ページヘッダ背景も ink で揃える (有効化時に page bg と連続して見えるよう)。
      pageHeader: {
        lightMode: {
          background: {
            color: INK,
          },
        },
      },
    },
  };
}

/**
 * ink テーマの assets。 form logo に Summit マーク (ink グリフ) を載せる。
 * white カード上に出るため DYNAMIC ではなく LIGHT 固定で ink マークを使う。
 */
export function buildInkManagedLoginAssets(): CfnManagedLoginBranding.AssetTypeProperty[] {
  return [
    {
      // Cognito は FORM_LOGO カテゴリでは resourceId を受け付けない
      // ("Resource Id is not supported for asset category 'FORM_LOGO'" で deploy が
      // UPDATE_FAILED になる)。 resourceId は icon 系カテゴリ専用なので FORM_LOGO では省く。
      category: "FORM_LOGO",
      colorMode: "LIGHT",
      extension: "SVG",
      bytes: SUMMIT_MARK_INK_SVG_BASE64,
    },
  ];
}
