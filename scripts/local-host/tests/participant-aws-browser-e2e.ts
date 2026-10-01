import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright-core";
import { createParticipantAwsFixture } from "./participant-aws-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = join(root, ".tenkacloud", "host-aws-access-e2e");
const linuxChrome = "/opt/pw-browsers/chromium";
const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function main() {
  const fixture = await createParticipantAwsFixture({
    staticRoot: join(root, ".tenkacloud", "host-build", "participant-portal"),
  });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.HOST_E2E_CHROMIUM ?? [linuxChrome, macChrome].find((path) => existsSync(path)),
    });
    const context = await browser.newContext({
      locale: "en-US",
      viewport: { width: 1440, height: 1100 },
    });
    const pageErrors: string[] = [];
    let signins = 0;
    await context.route("https://signin.aws.amazon.com/federation?**", async (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.searchParams.get("Action"), "login");
      assert.equal(
        url.searchParams.get("Destination"),
        "https://ap-northeast-1.console.aws.amazon.com/console/home?region=ap-northeast-1",
      );
      assert.equal(url.searchParams.get("SigninToken"), "viewer-signin-token");
      signins += 1;
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<h1>Mock AWS federation accepted</h1>",
      });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(
      `${fixture.origin}/login#invite=${encodeURIComponent(fixture.alpha.team.loginKey)}`,
    );
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"));
    await page.goto(`${fixture.origin}/tools/sso`);
    await page.getByRole("heading", { name: "SSO Credentials", exact: true }).waitFor();
    const newTab = context.waitForEvent("page");
    await page
      .getByRole("button", { name: "Open AWS Console for hello-world", exact: true })
      .click();
    const popup = await newTab;
    await popup.getByRole("heading", { name: "Mock AWS federation accepted" }).waitFor();
    assert.equal(signins, 1);
    await popup.close();
    await page
      .getByRole("button", { name: "CLI / SDK temporary credentials", exact: true })
      .click();
    await page.getByRole("button", { name: "Issue credentials", exact: true }).click();
    await page.getByText("participant_viewer-access", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Reveal secrets", exact: true }).click();
    await page.getByText("participant_viewer-secret", { exact: true }).waitFor();
    assert.equal(await page.getByText("competitor-secret", { exact: true }).count(), 0);
    const storage = await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    );
    assert.ok(!storage.includes("participant_viewer-secret"));
    assert.ok(!storage.includes("participant_viewer-token"));
    mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, "participant-console-cli.png"), fullPage: true });
    await page.getByRole("button", { name: "Clear from screen", exact: true }).click();
    assert.equal(await page.getByText("participant_viewer-secret", { exact: true }).count(), 0);
    assert.equal((await fixture.admin("/end")).status, 200);
    const denied = page.waitForResponse(
      (response) => response.url().includes("/console-signin-url") && response.status() === 409,
    );
    await page
      .getByRole("button", { name: "Open AWS Console for hello-world", exact: true })
      .click();
    await denied;
    await page.getByText("Could not open AWS Console", { exact: true }).waitFor();
    assert.equal(signins, 1);
    assert.deepEqual(pageErrors, []);
    const report = {
      passed: true,
      assertions: [
        "host runtime enables existing SSO page",
        "console popup consumes viewer federation URL",
        "CLI viewer credentials render and clear",
        "temporary credentials never enter browser storage",
        "ended event denies another console sign-in",
      ],
      externalBoundary: "STS and AWS federation are mocks; no real AWS calls or credentials",
    };
    writeFileSync(join(artifacts, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
