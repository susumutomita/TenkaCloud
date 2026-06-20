import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown, renderMarkdownToSafeHtml } from "../src/markdown";

/**
 * Issue #661 / #865 / #1700: metadata.json の markdown を sanitize 済 HTML として render する。
 * marked + DOMPurify の組合せが script / iframe / on-event handler を確実に剥がし、
 * かつ heading / list / table / code / 画像 を維持することを pin する。
 * (participant-portal から web-kit に抽出。 sanitize config は不変。)
 */
describe("renderMarkdownToSafeHtml (Issue #661 / #1700)", () => {
  it("should convert headings to HTML such as <h2>", () => {
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

  it("should wrap inline code in <code>", () => {
    const html = renderMarkdownToSafeHtml("use `npm install` to ...");
    expect(html).toContain("<code>npm install</code>");
  });

  it("should keep relative image paths", () => {
    const html = renderMarkdownToSafeHtml("![local](./assets/a.png)");
    expect(html).toMatch(/src="\.\/assets\/a\.png"/);
  });

  it("should keep same-origin absolute image paths", () => {
    const html = renderMarkdownToSafeHtml("![diagram](/assets/diagram.svg)");
    expect(html).toMatch(/<img[^>]+src="\/assets\/diagram\.svg"/);
    expect(html).toMatch(/alt="diagram"/);
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
    expect(html).not.toMatch(/href="javascript:/);
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

  describe("privacy hardening: external resource leak (#1929 follow-up)", () => {
    it("should drop external https images (= no third-party IP/Referer beacon)", () => {
      const html = renderMarkdownToSafeHtml("![diagram](https://cdn.example.com/a.png)");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("cdn.example.com");
    });

    it("should drop protocol-relative images", () => {
      const html = renderMarkdownToSafeHtml("![x](//evil.example.com/a.png)");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("evil.example.com");
    });

    it("should keep a bare <img> without a src attribute", () => {
      const html = renderMarkdownToSafeHtml("<img>");
      expect(html).toContain("<img");
    });

    it("should add rel=noreferrer noopener to links (= no Referer leak / tabnabbing)", () => {
      const html = renderMarkdownToSafeHtml("[docs](https://example.com/docs)");
      expect(html).toMatch(/<a[^>]+rel="noreferrer noopener"/);
      expect(html).toMatch(/href="https:\/\/example\.com\/docs"/);
    });

    it("should not add rel to an anchor without href", () => {
      const html = renderMarkdownToSafeHtml("<a>bare</a>");
      expect(html).toContain("<a>bare</a>");
      expect(html).not.toContain("rel=");
    });
  });
});

/**
 * Issue #1700: <Markdown> は sanitize 済 HTML を dangerouslySetInnerHTML で render する
 * 共有 component。 render 結果が DOM に反映されること / className が付くこと /
 * script が DOM に注入されないことを pin する。
 */
describe("Markdown component (Issue #1700)", () => {
  it("should render markdown headings into the DOM", () => {
    const { container } = render(<Markdown source={"## Title"} />);
    const heading = container.querySelector("h2");
    expect(heading?.textContent).toBe("Title");
  });

  it("should render a same-origin image element from markdown", () => {
    const { container } = render(<Markdown source={"![d](/assets/a.png)"} />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/assets/a.png");
  });

  it("should not render an external image element (privacy)", () => {
    const { container } = render(<Markdown source={"![d](https://example.com/a.png)"} />);
    expect(container.querySelector("img")).toBeNull();
  });

  it("should apply the className to the wrapper div", () => {
    const { container } = render(<Markdown source={"text"} className="prose" />);
    expect(container.querySelector("div.prose")).not.toBeNull();
  });

  it("should not inject a <script> element from malicious source", () => {
    const { container } = render(<Markdown source={"<script>alert(1)</script>ok"} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("ok");
  });
});
