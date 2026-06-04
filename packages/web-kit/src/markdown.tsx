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
 * Issue #661 / #865 / #1700: metadata.json の `description` 等の markdown source を HTML に
 * 変換し、 DOMPurify で sanitize した文字列を返す。 `<Markdown>` component または
 * `dangerouslySetInnerHTML` 経由で render する想定。
 *
 * 設計判断:
 *   - marked は default で raw HTML を許容する (= XSS リスク)。 ADR-008 で community
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
