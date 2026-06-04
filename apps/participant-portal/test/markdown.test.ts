import { describe, expect, it } from "vitest";
import { renderMarkdownToSafeHtml } from "../src/lib/markdown";

/**
 * Issue #1700: sanitize 本体と網羅テストは web-kit (`packages/web-kit/test/markdown.test.tsx`)
 * に移管した。 participant-portal 側は web-kit からの re-export であることを保証する
 * 統合 smoke test のみを残す (= import パス互換 + sanitize が効いていること)。
 */
describe("participant-portal markdown re-export (Issue #1700)", () => {
  it("should re-export renderMarkdownToSafeHtml from web-kit", () => {
    expect(typeof renderMarkdownToSafeHtml).toBe("function");
  });

  it("should still convert markdown headings via the re-export", () => {
    expect(renderMarkdownToSafeHtml("## 学習目的")).toMatch(/<h2[^>]*>学習目的<\/h2>/);
  });

  it("should still strip <script> via the re-export (sanitize wired)", () => {
    const html = renderMarkdownToSafeHtml("Hello <script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(1)");
  });
});
