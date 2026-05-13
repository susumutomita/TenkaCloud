import { describe, expect, it } from "vitest";
import { renderMarkdownToSafeHtml } from "../src/lib/markdown";

/**
 * Issue #661: metadata.json の markdown を sanitize 済 HTML として render する。
 * marked + DOMPurify の組合せが script / iframe / on-event handler を確実に剥がし、
 * かつ heading / list / table / code を維持することを pin する。
 */
describe("renderMarkdownToSafeHtml (Issue #661)", () => {
  it("heading を <h1> 等の HTML に変換すべき", () => {
    const html = renderMarkdownToSafeHtml("## 学習目的");
    expect(html).toMatch(/<h2[^>]*>学習目的<\/h2>/);
  });

  it("箇条書きを <ul><li> に変換すべき", () => {
    const html = renderMarkdownToSafeHtml("- 一つ目\n- 二つ目");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>一つ目</li>");
    expect(html).toContain("<li>二つ目</li>");
  });

  it("table を <table> に変換すべき", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |";
    const html = renderMarkdownToSafeHtml(md);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
  });

  it("コードブロックを <pre><code> に変換すべき", () => {
    const html = renderMarkdownToSafeHtml("```\nconst x = 1;\n```");
    expect(html).toMatch(/<pre>[\s\S]*<code>[\s\S]*const x = 1;/);
  });

  it("XSS: <script> を剥がすべき", () => {
    const html = renderMarkdownToSafeHtml("Hello <script>alert(1)</script> world");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(1)");
  });

  it("XSS: onerror handler を剥がすべき", () => {
    const html = renderMarkdownToSafeHtml('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert(1)");
  });

  it("XSS: javascript: スキームを剥がすべき", () => {
    const html = renderMarkdownToSafeHtml("[click](javascript:alert(1))");
    // marked が href 化、 DOMPurify が javascript: scheme を中和
    expect(html).not.toMatch(/href="javascript:/);
  });

  it("inline code を <code> 化すべき", () => {
    const html = renderMarkdownToSafeHtml("use `npm install` to ...");
    expect(html).toContain("<code>npm install</code>");
  });
});
