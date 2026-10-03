/** Built organizer/participant UIs, real HTTP and SQLite, with the real Battle runtime. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright-core";
import { fillOrganizerKey } from "./organizer-login";
import { type RegistrationSummary, registrationFixture } from "./registration-fixture";

async function main(): Promise<void> {
  const fixture = await registrationFixture({ browser: true });
  let browser: Browser | undefined;
  try {
    const event = await fixture.create(2);
    browser = await chromium.launch({
      executablePath:
        process.env.HOST_E2E_CHROMIUM ??
        (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined),
    });
    const organizer = await browser.newPage({ locale: "en-US" });
    const player = await browser.newPage({ locale: "en-US" });
    const errors: string[] = [];
    for (const page of [organizer, player]) {
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(() => {
        localStorage.setItem("tenkacloud.application-admin.locale", "en");
        localStorage.setItem("tenkacloud.portal.locale", "en");
      });
    }
    await organizer.goto(`${fixture.admin}/events/${event.eventId}`);
    await fillOrganizerKey(organizer, fixture.hostKey);
    await organizer.getByRole("button", { name: "Sign in", exact: true }).click();
    await organizer.getByRole("tab", { name: "Teams", exact: true }).click();
    await organizer
      .getByRole("button", { name: "Enable registration feature", exact: true })
      .click();
    await organizer
      .getByText("Host participant registration is enabled.", { exact: true })
      .waitFor();
    await organizer.getByRole("button", { name: /Select team slots/u }).click();
    for (const label of ["team-1", "team-2"])
      await organizer.getByRole("option", { name: new RegExp(label, "u") }).click();
    await organizer.keyboard.press("Escape");
    const deadline = await organizer.evaluate((now) => {
      const date = new Date(now + 3600_000);
      return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 16);
    }, fixture.now);
    await organizer
      .getByRole("textbox", { name: /Registration end date$/u })
      .fill(deadline.slice(0, 10).replaceAll("-", "/"));
    await organizer
      .getByRole("textbox", { name: /Registration end time$/u })
      .fill(deadline.slice(11));
    await organizer
      .getByRole("checkbox", {
        name: "These ready team environments may be assigned to participants.",
      })
      .check();
    await organizer
      .getByRole("button", { name: "Open registration and issue link", exact: true })
      .click();
    const invitationLink = organizer.getByRole("textbox", {
      name: "Registration link",
      exact: true,
    });
    await invitationLink.waitFor();
    const invitation = await invitationLink.inputValue();
    assert.equal(new URL(invitation).origin, fixture.participant);
    await player.goto(invitation);
    await player.getByRole("button", { name: "Get a team environment", exact: true }).waitFor();
    assert.equal(new URL(player.url()).hash, "");
    // Deliver the real claim to HTTP/SQLite, then lose only its response to the browser.
    await player.route(
      "**/portal/registration/**/claim",
      async (route) => {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await route.abort("failed");
      },
      { times: 1 },
    );
    await player.getByRole("button", { name: "Get a team environment", exact: true }).click();
    await player.getByRole("alert").waitFor();
    const before = await fixture.api<RegistrationSummary>(
      "admin",
      `/events/${event.eventId}/registration`,
    );
    assert.equal(before.body.claimed, 1);
    await organizer
      .getByRole("button", { name: "Disable registration feature", exact: true })
      .click();
    await organizer
      .getByText(
        "Host participant registration is disabled. Settings and existing team keys are retained.",
        { exact: true },
      )
      .waitFor();
    await player.reload();
    await player
      .getByRole("button", { name: "Start with this environment", exact: true })
      .waitFor();
    const after = await fixture.api<RegistrationSummary>(
      "admin",
      `/events/${event.eventId}/registration`,
    );
    assert.equal(after.body.claimed, 1);
    assert.equal(after.body.featureEnabled, false);
    const newcomer = await browser.newPage({ locale: "en-US" });
    await newcomer.addInitScript(() => localStorage.setItem("tenkacloud.portal.locale", "en"));
    await newcomer.goto(invitation);
    await newcomer.getByText("Registration is closed.", { exact: true }).waitFor();
    assert.equal(
      await newcomer
        .getByRole("button", { name: "Get a team environment", exact: true })
        .isDisabled(),
      true,
    );
    await newcomer.close();
    await player.getByRole("button", { name: "Start with this environment", exact: true }).click();
    await player.waitForURL((url) => url.pathname === "/setup");
    await player.getByRole("heading", { level: 1 }).waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(fixture.errors, []);
    const artifacts = join(
      fileURLToPath(new URL("../../../", import.meta.url)),
      ".tenkacloud/host-e2e",
    );
    mkdirSync(artifacts, { recursive: true });
    await organizer.screenshot({
      path: join(artifacts, "registration-off-settings.png"),
      fullPage: true,
    });
    await player.screenshot({
      path: join(artifacts, "registration-participant-setup.png"),
      fullPage: true,
    });
    console.log(
      "PASS registration browser: Admin opens pool; real claim with lost response; receipt reload while OFF; newcomer closed; existing key reaches setup. Real Battle/SQLite, no AWS.",
    );
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
