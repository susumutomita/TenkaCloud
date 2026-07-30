import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Issue #2696 PR 4 (P0 checkbox 1): the top-level README CTA used to be a flat
 * link row (Landing page / role manuals / Demo portal / Quickstart / Add your own problems).
 * The onboarding audit requires the FIRST thing after the intro paragraph to
 * present exactly two primary onboarding choices:
 *   A. Play first (recommended, no AWS, ~5 min) -> GitHub Codespaces
 *   B. Host your own event (AWS account, billed, ~30 min) -> Deploy on AWS
 * This file pins that both READMEs carry the two-choice block, in that
 * position, with working links into the existing Quickstart subsections.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..");
const readmeEn = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
const readmeJa = readFileSync(join(REPO_ROOT, "README.ja.md"), "utf8");

const CODESPACES_URL = "https://codespaces.new/susumutomita/TenkaCloud";
const DEPLOY_AWS_URL_EN = "#deploy-on-aws";

describe("README top CTA presents the two-choice onboarding split (Issue #2696 PR 4)", () => {
  it("should place the two-choice block before the Vision heading in README.md", () => {
    const introEnd = readmeEn.indexOf("TenkaCloud is a self-hostable, Apache-2.0 platform");
    const visionHeading = readmeEn.indexOf("\n## Vision");
    const playChoice = readmeEn.indexOf("Play first");
    const hostChoice = readmeEn.indexOf("Host your own event");
    expect(introEnd).toBeGreaterThan(-1);
    expect(visionHeading).toBeGreaterThan(introEnd);
    expect(playChoice).toBeGreaterThan(introEnd);
    expect(playChoice).toBeLessThan(visionHeading);
    expect(hostChoice).toBeGreaterThan(introEnd);
    expect(hostChoice).toBeLessThan(visionHeading);
  });

  it("should link the Play first choice to GitHub Codespaces in README.md", () => {
    const block = readmeEn.slice(
      readmeEn.indexOf("Play first"),
      readmeEn.indexOf("Host your own event"),
    );
    expect(block).toContain(CODESPACES_URL);
    expect(block).toMatch(/recommended.*no AWS.*~5 min/i);
  });

  it("should link the Host your own event choice to the Deploy on AWS section in README.md", () => {
    const block = readmeEn.slice(
      readmeEn.indexOf("Host your own event"),
      readmeEn.indexOf("[Landing page]"),
    );
    expect(block).toContain(DEPLOY_AWS_URL_EN);
    expect(block).toMatch(/AWS account.*billed.*~30 min/i);
  });

  it("should keep the secondary links (including role manuals) below the two-choice block in README.md", () => {
    const secondaryRow = readmeEn.indexOf("[Landing page]");
    const hostChoice = readmeEn.indexOf("Host your own event");
    expect(secondaryRow).toBeGreaterThan(hostChoice);
    expect(readmeEn).toContain(
      "[Landing page](https://tenkacloud.com) · [Manuals by role](https://tenkacloud.com/docs/manual/index.en.html) · [Demo portal](https://tenkacloud.com/portal-demo/?demo=1) · [Quickstart](#quickstart) · [Add your own problems](#add-your-own-problems)",
    );
  });

  it("should place the two-choice block before the ビジョン heading in README.ja.md", () => {
    const introEnd = readmeJa.indexOf("TenkaCloud は、ハンズオン形式の AWS 競技会を運営するための");
    const visionHeading = readmeJa.indexOf("\n## ビジョン");
    const playChoice = readmeJa.indexOf("まず遊ぶ");
    const hostChoice = readmeJa.indexOf("自分のイベントを開く");
    expect(introEnd).toBeGreaterThan(-1);
    expect(visionHeading).toBeGreaterThan(introEnd);
    expect(playChoice).toBeGreaterThan(introEnd);
    expect(playChoice).toBeLessThan(visionHeading);
    expect(hostChoice).toBeGreaterThan(introEnd);
    expect(hostChoice).toBeLessThan(visionHeading);
  });

  it("should link the まず遊ぶ choice to GitHub Codespaces in README.ja.md", () => {
    const block = readmeJa.slice(
      readmeJa.indexOf("まず遊ぶ"),
      readmeJa.indexOf("自分のイベントを開く"),
    );
    expect(block).toContain(CODESPACES_URL);
    expect(block).toMatch(/推奨.*AWS 不要.*約 5 分/);
  });

  it("should link the 自分のイベントを開く choice to the AWS にデプロイする section in README.ja.md", () => {
    const block = readmeJa.slice(
      readmeJa.indexOf("自分のイベントを開く"),
      readmeJa.indexOf("[ランディングページ]"),
    );
    expect(block).toMatch(/#aws-にデプロイする/);
    expect(block).toMatch(/AWS アカウント.*課金あり.*約 30 分/);
  });

  it("should keep the secondary links, including role manuals, below the two-choice block in README.ja.md", () => {
    const secondaryRow = readmeJa.indexOf("[ランディングページ]");
    const hostChoice = readmeJa.indexOf("自分のイベントを開く");
    expect(secondaryRow).toBeGreaterThan(hostChoice);
    expect(readmeJa).toContain(
      "[ランディングページ](https://tenkacloud.com) · [役割別マニュアル](https://tenkacloud.com/docs/manual/) · [デモポータル](https://tenkacloud.com/portal-demo/?demo=1) · [クイックスタート](#クイックスタート) · [自分の問題を追加する](#自分の問題を追加する)",
    );
  });
});
