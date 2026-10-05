/** Browser rehearsal uses only fresh in-memory SQLite and synthetic fixture resources. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium, type Page } from "playwright-core";
import { apiDocsFixture } from "./api-docs-fixture";

async function execute(
  page: Page,
  id: string,
  body?: unknown,
  parameters: Record<string, string> = {},
  initialBody?: unknown,
) {
  const operation = page.locator(`#operations-default-${id}`);
  if (!(await operation.evaluate((element) => element.classList.contains("is-open"))))
    await operation.locator(".opblock-summary").click();
  const toggle = operation.getByRole("button", { name: /^(Try it out|Cancel)$/u });
  await toggle.waitFor({ state: "visible" });
  if ((await toggle.innerText()).trim() === "Try it out") await toggle.click();
  if (initialBody !== undefined)
    assert.deepEqual(JSON.parse(await operation.locator("textarea").inputValue()), initialBody);
  if (body) await operation.locator("textarea").fill(JSON.stringify(body));
  for (const [name, value] of Object.entries(parameters))
    await operation.locator(`input[placeholder="${name}"]`).fill(value);
  const response = page.waitForResponse(
    (r) => r.url().includes("/api/") && r.request().method() !== "OPTIONS",
  );
  await operation.getByRole("button", { name: "Execute", exact: true }).click();
  const received = await response;
  if (initialBody !== undefined) assert.deepEqual(received.request().postDataJSON(), initialBody);
  return received;
}
async function authorize(page: Page, token: string) {
  await page.locator(".auth-wrapper").getByRole("button", { name: "Authorize" }).click();
  const dialog = page.locator(".dialog-ux");
  await dialog.locator("input").fill(token);
  await dialog.locator("button.authorize").click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
}
const f = await apiDocsFixture(true);
const executablePath =
  process.env.HOST_E2E_CHROMIUM ??
  [
    "/opt/pw-browsers/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((path) => existsSync(path));
const browser = await chromium.launch(executablePath ? { executablePath } : {});
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
  assert.equal((await execute(host, "prepareEvent", undefined, { eventId }, {})).status(), 202);
  let prepared:
    | { status: string; deploymentsByProblem: Record<string, { status: string }[]> }
    | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    const status = await execute(host, "eventStatus", undefined, { eventId });
    assert.equal(status.status(), 200);
    prepared = await status.json();
    if (prepared?.status === "READY") break;
  }
  assert.ok(prepared);
  assert.equal(prepared.status, "READY");
  assert.equal(prepared.deploymentsByProblem["sqli-demo"]?.[0]?.status, "STOPPED");
  assert.equal(
    (await execute(host, "startEvent", undefined, { eventId }, { startNow: true })).status(),
    200,
  );
  const participant = await context.newPage();
  await participant.goto(`${f.participant.origin}/api-docs`);
  await participant.locator("#operations-default-joinEvent").waitFor();
  await authorize(participant, teams[0].teamLoginKey);
  assert.equal((await execute(participant, "joinEvent")).status(), 200);
  const answer = { problemId: "sqli-demo", flag: "synthetic-answer" };
  assert.equal((await execute(participant, "submitFlag", answer)).status(), 409);
  assert.equal(
    (
      await execute(participant, "startContainer", undefined, { problemId: "sqli-demo" }, {})
    ).status(),
    202,
  );
  let container: { status: string } | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    const state = await execute(participant, "joinEvent");
    assert.equal(state.status(), 200);
    container = (await state.json()).problems.find(
      (problem: { problemId: string }) => problem.problemId === "sqli-demo",
    ).containerSession;
    if (container?.status === "running" || container?.status === "error") break;
  }
  assert.ok(container);
  assert.equal(container.status, "running");
  assert.equal(
    (
      await execute(participant, "submitFlag", { problemId: "sqli-demo", flag: "synthetic-answer" })
    ).status(),
    200,
  );
  assert.equal((await execute(host, "endEvent", undefined, { eventId })).status(), 200);
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
