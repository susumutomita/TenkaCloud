import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { hostBuildDirectory } from "../build";
import { disruptionFixture } from "./disruption-fixture";
import { signInOrganizer } from "./organizer-login";

const root = fileURLToPath(new URL("../../../", import.meta.url));

async function main(): Promise<void> {
  const fixture = await disruptionFixture({
    staticRoot:
      process.env.HOST_E2E_ADMIN_BUILD ?? hostBuildDirectory(root, "application-admin-console"),
  });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      executablePath:
        process.env.HOST_E2E_CHROMIUM ??
        (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined),
    });
    let context = await browser.newContext({ locale: "en-US" });
    let page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    async function signIn(): Promise<void> {
      await page.clock.setFixedTime(new Date(fixture.aws.now));
      await signInOrganizer(page, { admin: fixture.origin, key: fixture.organizerKey });
      await page.locator(`a[href="/events/${fixture.event.eventId}"]`).click();
      await page.getByRole("tab", { name: "Disruptions", exact: true }).click();
      await page.getByRole("heading", { name: "Disruptions (red team)", exact: true }).waitFor();
    }
    await signIn();
    await openFire(page);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /All teams/u })
      .click();
    await page.getByRole("option", { name: "Random teams", exact: true }).click();
    await page.getByLabel("Number of random teams", { exact: true }).fill("1");
    await confirmFire(page);
    await page
      .getByText("Request accepted. Execution results appear in the history below.")
      .waitFor();
    assert.equal(fixture.rows().length, 1);
    await fixture.tick();
    assert.equal(fixture.aws.commands.length, 1);
    assert.deepEqual([...fixture.aws.running.values()], [false]);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByText(/Injection command finished; revert pending/u).waitFor();
    fixture.advance(600_000);
    await fixture.tick();
    assert.deepEqual([...fixture.aws.running.values()], [true]);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByText(/Revert command completed; health unverified/u).waitFor();

    await openFire(page);
    await page.getByRole("dialog").getByRole("button", { name: "Recurring", exact: true }).click();
    await page.getByLabel("Interval (minutes)", { exact: true }).fill("1");
    await page.getByLabel("Max fires", { exact: true }).fill("3");
    await confirmFire(page);
    await page
      .getByRole("heading", { name: "Active recurring disruptions (1)", exact: true })
      .waitFor();
    assert.equal(fixture.rows().filter((row) => row.status === "queued").length, 6);
    const retainedTeams = fixture.rows().map((row) => row.teamId);
    await fixture.restart();
    await context.close();
    context = await browser.newContext({ locale: "en-US" });
    page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await signIn();
    assert.deepEqual(
      fixture.rows().map((row) => row.teamId),
      retainedTeams,
    );
    await page
      .getByRole("heading", { name: "Active recurring disruptions (1)", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page
      .getByRole("heading", { name: "Active recurring disruptions (1)", exact: true })
      .waitFor({ state: "hidden" });
    fixture.advance(180_000);
    await fixture.tick();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page
      .getByText(/#3: Skipped/u)
      .first()
      .waitFor();
    assert.equal(fixture.rows().filter((row) => row.status === "skipped").length, 6);
    assert.equal(fixture.aws.commands.length, 2);
    assert.deepEqual(pageErrors, []);
    const artifacts = join(root, ".tenkacloud/host-e2e");
    mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, "disruption-history.png"), fullPage: true });
    console.log(
      "PASS disruption browser rehearsal with real HTTP, SQLite and the built console. SSM is test-only.",
    );
  } finally {
    await browser?.close();
    await fixture.close();
  }
}

async function openFire(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Fire", exact: true }).click();
  await page.getByRole("dialog").waitFor();
}

async function confirmFire(page: Page): Promise<void> {
  const response = page.waitForResponse((each) => each.url().endsWith("/disruptions/fire"));
  await page.getByRole("button", { name: "Fire disruption", exact: true }).click();
  assert.equal((await response).status(), 202);
  await page.getByRole("dialog").waitFor({ state: "hidden" });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
