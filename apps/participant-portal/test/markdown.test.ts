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

  describe("Issue #865: DOMPurify allowlist 強化", () => {
    it("data: URL scheme を href から剥がすべき (= data:text/html;base64 XSS gadget 防御)", () => {
      const html = renderMarkdownToSafeHtml(
        "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
      );
      expect(html).not.toMatch(/href="data:/);
    });

    it("vbscript: scheme を href から剥がすべき", () => {
      const html = renderMarkdownToSafeHtml("[click](vbscript:msgbox(1))");
      expect(html).not.toMatch(/href="vbscript:/);
    });

    it("file: scheme を href から剥がすべき", () => {
      const html = renderMarkdownToSafeHtml("[click](file:///etc/passwd)");
      expect(html).not.toMatch(/href="file:/);
    });

    it("<iframe> は ALLOWED_TAGS に無いので剥がすべき", () => {
      const html = renderMarkdownToSafeHtml(
        '<iframe src="https://attacker.evil.com"></iframe>Hello',
      );
      expect(html).not.toContain("<iframe");
      expect(html).toContain("Hello");
    });

    it("<form action> は剥がすべき (= clickjacking / data exfil gadget)", () => {
      const html = renderMarkdownToSafeHtml('<form action="https://attacker"><input></form>');
      expect(html).not.toContain("<form");
    });

    it("<style> は剥がすべき (= CSS-based exfil)", () => {
      const html = renderMarkdownToSafeHtml("<style>@import url(https://attacker/exfil)</style>Hi");
      expect(html).not.toContain("<style");
      expect(html).toContain("Hi");
    });

    it("onclick attribute は FORBID_ATTR で剥がすべき", () => {
      const html = renderMarkdownToSafeHtml(
        '<a href="https://example.com" onclick="alert(1)">x</a>',
      );
      expect(html).not.toContain("onclick");
    });

    it("正常な https:// link は保持すべき", () => {
      const html = renderMarkdownToSafeHtml("[docs](https://example.com/docs)");
      expect(html).toMatch(/href="https:\/\/example\.com\/docs"/);
    });

    it("mailto: link は保持すべき", () => {
      const html = renderMarkdownToSafeHtml("[mail](mailto:a@example.com)");
      expect(html).toMatch(/href="mailto:a@example\.com"/);
    });
  });
});
