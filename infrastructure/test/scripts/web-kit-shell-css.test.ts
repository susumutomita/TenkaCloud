import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The admin console header rendered 「管理コン...」 instead of 「管理コンソール」.
 *
 * #2662 pinned `flex-shrink: 0` on the identity div, but that is only the outermost of three
 * nested flex levels. Measured in a real browser at viewport 1280px — the wide responsive state,
 * with the rest of the header nearly empty:
 *
 *   awsui_identity      div : flex-shrink 0   <- the #2662 rule, working
 *   awsui_identity-link a   : flex-shrink 1   <- shrinks here
 *   awsui_title         span: flex-shrink 1, overflow hidden, 102px vs 124px scrollWidth
 *
 * So Cloudscape shrinks the identity regardless of available width; it was never a "too narrow"
 * problem. jsdom has no layout engine, so truncation itself cannot be asserted — this pins the
 * three rules instead, and removing any one brings the truncation back.
 *
 * This lives in the infrastructure suite rather than next to ShellLayout because the web-kit
 * package's tsconfig carries no node types, and vitest stubs `?raw` CSS imports to an empty
 * string there — neither way of reading the file works from inside that package.
 */
describe("web-kit shell-layout.css (console title truncation)", () => {
  const css = readFileSync(
    resolve(__dirname, "..", "..", "..", "packages", "web-kit", "src", "shell-layout.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  it("should stop Cloudscape from shrinking the identity at every level", () => {
    for (const selector of [
      "header > div > :first-child",
      'header [class*="awsui_identity-link"]',
      'header [class*="awsui_title"]',
    ]) {
      const block = css.match(
        new RegExp(
          `\\.tenkacloud-shell-top-navigation ${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
        ),
      );
      expect(block, `no rule for ${selector}`).not.toBeNull();
      expect(block?.[1], `${selector} does not pin flex-shrink`).toMatch(/flex-shrink:\s*0/);
    }
  });
});
