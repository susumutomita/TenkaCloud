import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * Issue #1700: participant-portal の `lib/markdown.ts` (Issue #661 / #865) を web-kit に
 * 抽出し、 admin-console / participant-portal の両方から共有する。 sanitize config は
 * participant-portal のものをそのまま移植 (= 既存挙動不変)。 participant-portal 側は
 * 本モジュールの re-export になる。
 *
 * DOMPurify config を allowlist 形式に明示化 (= permissive default を排除)。
 * marked の出力に含まれる可能性のあるタグのみを許容し、 `<iframe>` / `<script>` /
 * `<form>` / `<style>` などは default で剥がれる。 attribute は href / target / rel /
 * code highlight 用 class / 画像 (src / alt / title) のみ。 event handler
 * (onerror / onclick 等) は ALLOWED_ATTR に含まれていないので strip されるが、
 * DOMPurify の version regression を想定して FORBID_ATTR でも hardcode する
 * (= defense-in-depth)。
 *
 * `ALLOWED_URI_REGEXP` で href / src の URL scheme を制限 — `http://` / `https://` /
 * `mailto:` / 相対パス (`/`, `#`, `?`) のみ。 `javascript:` / `data:` / `vbscript:`
 * は reject される。
 *
 * さらに privacy hardening として DOMPurify hook を 2 本登録する (詳細は後段)。 問題作者
 * (community contribution = 非信頼) の埋め込み外部リソースから、 閲覧した競技者の IP /
 * Referer が第三者ホストへ漏れるのを塞ぐ — 外部 `<img>` を除去し、 `<a>` には
 * `rel="noreferrer noopener"` を付与する。
 */
const ALLOWED_TAGS = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "br",
  "hr",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "del",
  "code",
  "pre",
  "blockquote",
  "a",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "img",
];

const ALLOWED_ATTR = ["href", "target", "rel", "class", "src", "alt", "title"];

/**
 * 既知の event handler attribute を ALLOWED_ATTR の補集合に対して明示禁止する。
 * DOMPurify default も同じだが、 future version regression のための redundant 防御。
 */
const FORBID_ATTR = [
  "onerror",
  "onload",
  "onclick",
  "onmouseover",
  "onmouseout",
  "onfocus",
  "onblur",
  "onchange",
  "onsubmit",
  "formaction",
];

/**
 * URL scheme の allowlist。 `http://` / `https://` / `mailto:` / fragment / 相対パスのみ。
 * `javascript:` / `data:` / `vbscript:` / `file:` を弾く。
 */
const ALLOWED_URI_REGEXP = /^(?:https?:|mailto:|#|\/|\.{1,2}\/|\?)/i;

/**
 * 外部リソース URL の判定 — scheme 付き (`https:` 等) または protocol-relative (`//host`)。
 * 相対パス (`/diagram.svg`, `./a.png`) と fragment は同一オリジン扱いで false を返す。
 */
const EXTERNAL_RESOURCE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
export function isExternalResourceUrl(src: string | null): boolean {
  return src !== null && EXTERNAL_RESOURCE_URL.test(src.trim());
}

/**
 * Privacy hardening hooks (catnose99「Web サービス公開前チェックリスト」の入力検証 /
 * プライバシー項目)。 DOMPurify singleton に module load 時 1 度だけ登録する。
 *
 *   1. 外部 `<img>` を除去 — 競技者ブラウザが作者管理ホストへ beacon (IP / Referer 漏洩 /
 *      tracking pixel) しないようにする。 同一オリジン / 相対パス (= repo に commit した
 *      diagram) のみ残す。
 *   2. `<a>` に `rel="noreferrer noopener"` を付与 — リンク遷移時の Referer 漏洩と
 *      reverse tabnabbing を防ぐ (app 全体の既存方針と一致)。
 *
 * いずれも非信頼な markdown source を render する全 caller (participant-portal /
 * application-admin-console) に効く single choke point。
 */
DOMPurify.addHook("uponSanitizeElement", (node, data) => {
  const el = node as Element;
  if (data.tagName === "img" && isExternalResourceUrl(el.getAttribute("src"))) {
    el.remove();
  }
});
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("href")) {
    node.setAttribute("rel", "noreferrer noopener");
  }
});

/**
 * Issue #661 / #865 / #1700: metadata.json の `description` 等の markdown source を HTML に
 * 変換し、 DOMPurify で sanitize した文字列を返す。 `<Markdown>` component または
 * `dangerouslySetInnerHTML` 経由で render する想定。
 *
 * 設計判断:
 *   - marked は default で raw HTML を許容する (= XSS リスク)。community
 *     contribution を受け入れる前提のため必ず DOMPurify を後段に挟む
 *   - rendering は同期 (= marked.parse の async option 非使用) で React 描画と整合
 *   - 許容 tag / attribute を allowlist 化、 javascript: scheme を ALLOWED_URI_REGEXP で reject
 */
export function renderMarkdownToSafeHtml(source: string): string {
  const rawHtml = marked.parse(source, { async: false }) as string;
  // ALLOWED_TAGS / ALLOWED_ATTR の明示 allowlist は USE_PROFILES の add-on ではなく
  // 「これだけ許す」 と読まれるため、 USE_PROFILES は併用しない (= 併用すると profile の
  // tag が漏れる risk)。 SVG / MathML は default で disable される。
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_ATTR,
    ALLOWED_URI_REGEXP,
  });
}

export interface MarkdownProps {
  /** markdown source (metadata.json の description 等) */
  source: string;
  /** wrapper の追加 className (任意) */
  className?: string;
}

/**
 * Issue #1700: markdown source を `renderMarkdownToSafeHtml` で sanitize し、
 * `dangerouslySetInnerHTML` で render する共有 component。 admin-console ProblemDetail と
 * participant-portal が共有する。
 *
 * `dangerouslySetInnerHTML` は **DOMPurify で sanitize 済みの HTML にのみ** 許容する
 * (= raw user input を直接渡さない)。 これが本 component の唯一の責務であり、 呼び出し側で
 * 個別に sanitize させない (= 抜け漏れ防止の single choke point)。
 */
export function Markdown({ source, className }: MarkdownProps) {
  const html = renderMarkdownToSafeHtml(source);
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdownToSafeHtml が DOMPurify allowlist sanitize 済 (#661 / #865 / #1700)
    <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
