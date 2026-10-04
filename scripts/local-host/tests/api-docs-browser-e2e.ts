/** Browser rehearsal uses only fresh in-memory SQLite and synthetic fixture resources. */
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright-core";
import { apiDocsFixture } from "./api-docs-fixture";

async function execute(page: Page, id: string, body?: unknown, eventId?: string) {
  const operation = page.locator(`#operations-default-${id}`);
  await operation.locator(".opblock-summary").click();
  await operation.getByRole("button", { name: "Try it out" }).click();
  if (body) await operation.locator("textarea").fill(JSON.stringify(body));
  if (eventId) await operation.locator('input[placeholder="eventId"]').fill(eventId);
  const response = page.waitForResponse(
    (r) => r.url().includes("/api/") && r.request().method() !== "OPTIONS",
  );
  await operation.getByRole("button", { name: "Execute", exact: true }).click();
  return response;
}
async function authorize(page: Page, token: string) {
  await page.locator(".auth-wrapper").getByRole("button", { name: "Authorize" }).click();
  const dialog = page.locator(".dialog-ux");
  await dialog.locator("input").fill(token);
  await dialog.locator("button.authorize").click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
}
const f = await apiDocsFixture();
const browser = await chromium.launch({
  executablePath:
    process.env.HOST_E2E_CHROMIUM ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
try {
  const context = await browser.newContext();
  const errors: string[] = [];
  const external: string[] = [];
  context.on("page", (page) => {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (![f.admin.origin, f.participant.origin].includes(new URL(request.url()).origin))
        external.push(request.url());
    });
  });
  const host = await context.newPage();
  await host.goto(`${f.admin.origin}/api-docs`);
  await host.locator("#operations-default-loginHost").waitFor();
  const login = await execute(host, "loginHost", { key: f.key });
  assert.equal(login.status(), 200);
  const { idToken } = await login.json();
  await authorize(host, idToken);
  const created = await execute(host, "createEvent", {
    name: "Browser synthetic event",
    teams: [{ internalSlug: "browser-team" }],
    problems: [{ problemId: "sqli-demo" }],
  });
  assert.equal(created.status(), 201);
  const { eventId, teams } = await created.json();
  assert.equal((await execute(host, "prepareEvent", {}, eventId)).status(), 202);
  await f.service.drain();
  assert.equal((await execute(host, "eventStatus", undefined, eventId)).status(), 200);
  assert.equal((await execute(host, "startEvent", { startNow: true }, eventId)).status(), 200);
  const participant = await context.newPage();
  await participant.goto(`${f.participant.origin}/api-docs`);
  await participant.locator("#operations-default-joinEvent").waitFor();
  await authorize(participant, teams[0].teamLoginKey);
  assert.equal((await execute(participant, "joinEvent")).status(), 200);
  assert.equal(
    (
      await execute(participant, "submitFlag", { problemId: "sqli-demo", flag: "synthetic-answer" })
    ).status(),
    200,
  );
  assert.equal((await execute(host, "endEvent", undefined, eventId)).status(), 200);
  assert.equal((await execute(participant, "teamResults")).status(), 200);
  for (const page of [host, participant]) {
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await page.reload();
    const probe = page === host ? "listEvents" : "joinEvent";
    assert.equal((await execute(page, probe)).status(), 401);
  }
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  console.log(
    "Swagger browser lifecycle passed: both roles, memory-only credentials, no external requests.",
  );
} finally {
  await browser.close();
  await f.close();
}
