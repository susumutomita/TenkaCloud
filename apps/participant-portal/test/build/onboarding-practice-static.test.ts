import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("onboarding practice endpoint", () => {
  it("should provide the connection code and final flag outside the hint flow", async () => {
    const html = await readFile(resolve(process.cwd(), "public/onboarding-practice.html"), "utf8");

    expect(html).toContain("CONNECTED");
    expect(html).toContain("TC{HELLO-TENKACLOUD}");
    expect(html).toContain("ポータルの問題画面へ戻");
  });

  it("should carry both locales and resolve the language the portal hands it", async () => {
    const html = await readFile(resolve(process.cwd(), "public/onboarding-practice.html"), "utf8");
    const css = await readFile(resolve(process.cwd(), "public/onboarding-practice.css"), "utf8");

    // Every Japanese instruction has an English counterpart on the same page.
    expect(html).toContain('data-lang="ja"');
    expect(html).toContain('data-lang="en"');
    expect(html).toContain("You reached the practice environment");
    expect(html).toContain("Connection code");
    expect(html).toContain("Completion proof");

    // The link from the portal carries ?lang=, and a direct visit falls back to
    // the portal's persisted locale. The storage key must stay in lockstep with
    // the i18n factory's, or direct visits silently stop following the switcher.
    expect(html).toContain('get("lang")');
    expect(html).toContain("tenkacloud.portal.locale");

    // The stylesheet hides the non-selected language; without JavaScript
    // nothing is stamped and both languages stay visible.
    expect(css).toContain('html[data-lang="ja"] [data-lang="en"]');
    expect(css).toContain('html[data-lang="en"] [data-lang="ja"]');

    // The submitted values are shared between the two languages, not duplicated
    // per language, so the graded strings cannot drift apart.
    expect(html.split("CONNECTED").length - 1).toBe(1);
    expect(html.split("TC{HELLO-TENKACLOUD}").length - 1).toBe(1);
  });
});
