/** Real built UI and HTTP/SQLite; outbound AWS calls use the test transport only. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright-core";
import { hostBuildDirectory } from "../build";
import { fakeFlag } from "./fake-aws";
import { signInOrganizer } from "./organizer-login";
import { progressionFixture, START } from "./progression-fixture";

async function main(): Promise<void> {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const fixture = await progressionFixture({
    adminBuild:
      process.env.HOST_E2E_ADMIN_BUILD ?? hostBuildDirectory(root, "application-admin-console"),
    participantBuild:
      process.env.HOST_E2E_PARTICIPANT_BUILD ?? hostBuildDirectory(root, "participant-portal"),
  });
  let browser: Browser | undefined;
  try {
    const event = await fixture.create("browser gate");
    const team = event.teams[0];
    assert.ok(team);
    browser = await chromium.launch({
      executablePath:
        process.env.HOST_E2E_CHROMIUM ??
        (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined),
    });
    const organizer = await browser.newPage({ locale: "en-US" });
    await organizer.clock.setFixedTime(new Date(START));
    const errors: string[] = [];
    organizer.on("pageerror", (error) => errors.push(error.message));
    async function signIn() {
      await signInOrganizer(organizer, { admin: fixture.adminOrigin, key: "gate-test-host-key" });
      await organizer.locator(`a[href="/events/${event.eventId}"]`).click();
      await organizer
        .getByRole("tab", { name: "Progression / Gate (Advanced)", exact: true })
        .click();
    }
    await signIn();
    await toggleGate();
    await organizer.getByRole("button", { name: /Gate challenge/u }).click();
    await organizer.getByRole("option", { name: "hello-world", exact: true }).click();
    await organizer.getByRole("button", { name: /Unlock targets/u }).click();
    await organizer.getByRole("option", { name: "ac26-crypto-battle", exact: true }).click();
    await organizer.keyboard.press("Escape");
    await organizer.getByLabel("Completion bonus (all teams)").fill("50");
    const saved = organizer.waitForResponse(
      (response) =>
        response.url().endsWith("/progression-gate") && response.request().method() === "PUT",
    );
    await organizer.getByRole("button", { name: "Save gate settings", exact: true }).click();
    assert.equal((await saved).status(), 200);
    assert.equal(fixture.store.event(event.eventId).progressionGate?.completionBonus, 50);

    const player = await browser.newPage({ locale: "en-US" });
    await player.clock.setFixedTime(new Date(START));
    player.on("pageerror", (error) => errors.push(error.message));
    await player.goto(
      `${fixture.participantOrigin}/login#invite=${encodeURIComponent(team.teamLoginKey)}`,
    );
    await player.getByRole("button", { name: "Sign in", exact: true }).click();
    await player.waitForURL((url) => !url.pathname.startsWith("/login"));
    await player.goto(`${fixture.participantOrigin}/problems`);
    await player.getByText("Locked", { exact: true }).first().waitFor();
    const job = fixture.store
      .jobs(event.eventId, team.teamId)
      .find((each) => each.problemId === "hello-world");
    assert.ok(job);
    await player.goto(`${fixture.participantOrigin}/problems/${job.jobId}`);
    await player
      .getByLabel(/Flag/u)
      .first()
      .fill(fakeFlag((JSON.parse(job.unit ?? "{}") as { stackName: string }).stackName));
    await player
      .getByRole("button", { name: /Submit flag/u })
      .first()
      .click();
    await player
      .getByText(/Correct!/u)
      .first()
      .waitFor();
    assert.equal(fixture.store.team(team.teamId).score, 150);
    await player.goto(`${fixture.participantOrigin}/problems`);
    await player.getByText("Locked", { exact: true }).waitFor({ state: "hidden" });

    await toggleGate();
    await organizer.getByText("Progression Gate is disabled (default OFF)").waitFor();
    assert.equal(fixture.store.event(event.eventId).progressionGate?.completionBonus, 50);
    await fixture.restart();
    async function toggleGate() {
      const changed = organizer.waitForResponse(
        (response) =>
          response.url().endsWith("/api/feature-flags") && response.request().method() === "PUT",
      );
      await organizer.getByLabel("Enable progression gates on this host (Admin only)").click();
      assert.equal((await changed).status(), 200);
    }
    await signIn();
    await toggleGate();
    await organizer.getByRole("button", { name: "Remove gate", exact: true }).waitFor();
    assert.equal(fixture.store.team(team.teamId).score, 150);
    assert.deepEqual(errors, []);
    const artifacts = join(root, ".tenkacloud/host-e2e");
    mkdirSync(artifacts, { recursive: true });
    await organizer.screenshot({
      path: join(artifacts, "progression-settings.png"),
      fullPage: true,
    });
    console.log(
      "PASS progression browser: saved gate, participant lock/unlock, single bonus, flag OFF and SQLite restart. AWS transport is test-only.",
    );
  } catch (error) {
    const artifacts = join(root, ".tenkacloud/host-e2e");
    mkdirSync(artifacts, { recursive: true });
    for (const [index, page] of (
      browser?.contexts().flatMap((context) => context.pages()) ?? []
    ).entries()) {
      console.error(await page.locator("body").innerText());
      await page.screenshot({
        path: join(artifacts, `progression-failure-${index}.png`),
        fullPage: true,
      });
    }
    throw error;
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
