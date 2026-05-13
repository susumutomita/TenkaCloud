import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * Issue #661: metadata.json の \`description\` 等の markdown source を HTML に変換し、
 * DOMPurify で sanitize した文字列を返す。 ProblemDetail / ProblemInfoSection で
 * \`dangerouslySetInnerHTML\` 経由で render する想定。
 *
 * 設計判断:
 *   - marked は default で raw HTML を許容する (= XSS リスク)。 ADR-008 で community
 *     contribution を受け入れる前提のため必ず DOMPurify を後段に挟む
 *   - rendering は同期 (= marked.parse の async option 非使用) で React 描画と整合
 *   - heading / list / table / code block / link / strong / em のみ保持し、 script /
 *     iframe / style 等は剥がす (= DOMPurify default profile で十分)
 */
export function renderMarkdownToSafeHtml(source: string): string {
  const rawHtml = marked.parse(source, { async: false }) as string;
  return DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
  });
}
