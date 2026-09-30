/**
 * Browser rehearsal of a local competition (Issue #3226), driven only through what the
 * organizer and participants see: the built host console and participant portal, served by
 * `e2e-host.ts` (production wiring over a temporary data directory).
 *
 * Organizer: one-time Admin bootstrap, password sign-in, event creation, deploy, and start.
 * Participants: two independent browser contexts sign in with their team keys, open their own
 * exercise through the portal link, obtain the flag through that exercise's login form, submit
 * it in the portal, and see the ranking. Organizer: end the event and tear the environments down.
 *
 * Requires a prior `bun run build:host`. Uses a preinstalled Chromium (PLAYWRIGHT_BROWSERS_PATH
 * or HOST_E2E_CHROMIUM); it never downloads browsers.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { signInOrganizer } from "./organizer-login";

interface HostInfo {
  admin: string;
  participant: string;
  key: string;
  engine: "fixture" | "docker";
}

const root = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = join(root, ".tenkacloud/host-e2e");
const STEP_TIMEOUT = 90_000;

function chromiumPath(): string | undefined {
  const explicit = process.env.HOST_E2E_CHROMIUM;
  if (explicit) return explicit;
  const preinstalled = "/opt/pw-browsers/chromium";
  // Otherwise Playwright resolves its own browser under PLAYWRIGHT_BROWSERS_PATH.
  return existsSync(preinstalled) ? preinstalled : undefined;
}

async function startHost(): Promise<{ info: HostInfo; child: ChildProcess }> {
  const child = spawn(process.execPath, ["run", "scripts/local-host/tests/e2e-host.ts"], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout ?? process.stdin });
  const info = await new Promise<HostInfo>((accept, reject) => {
    child.once("exit", (code) => reject(new Error(`Host exited early (${String(code)}).`)));
    lines.once("line", (line) => accept(JSON.parse(line) as HostInfo));
  });
  return { info, child };
}

async function stopHost(child: ChildProcess): Promise<void> {
  let code = child.exitCode;
  let signal = child.signalCode;
  if (code === null && signal === null) {
    const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (accept) =>
        child.once("exit", (exitCode, exitSignal) =>
          accept({ code: exitCode, signal: exitSignal }),
        ),
    );
    if (!child.kill("SIGTERM") && child.exitCode === null && child.signalCode === null)
      throw new Error("Could not signal the browser fixture host to clean up its jobs.");
    ({ code, signal } = await completed);
  }
  if (code !== 0) {
    const status = code === null ? `signal ${String(signal)}` : `code ${String(code)}`;
    throw new Error(
      `Browser fixture host exited with ${status}. Check stderr for retained SQLite ownership.`,
    );
  }
}

async function createEvent(page: Page, name: string): Promise<Map<string, string>> {
  // In-app navigation: the session lives in memory only, so a reload means signing in again.
  await page.getByRole("button", { name: "Create event" }).first().click();
  await page.getByLabel("Event name").fill(name);
  const count = page.getByLabel("Team count");
  await count.fill("2");
  await page.getByTestId("problem-select").click();
  await page.getByRole("option", { name: /sqli-demo/u }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Create Event" }).click();
  const modal = page.getByRole("dialog");
  await modal.getByText("Save these login keys now").waitFor();
  const keys = new Map<string, string>();
  for (const slug of ["team-1", "team-2"]) {
    const row = modal.getByRole("row").filter({ hasText: slug });
    const key = (await row.locator("td").nth(1).innerText()).trim();
    assert.match(key, /^[A-Za-z0-9_-]{43}$/u, `login key for ${slug}`);
    keys.set(slug, key);
  }
  await page.getByTestId("deploy-prompt-now").click();
  await page.waitForURL(/\/events\/[0-9A-Z]{26}$/u);
  return keys;
}

async function waitForReady(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Teams" }).click();
  const panel = page.getByText("Problem environments per team").first();
  await panel.waitFor();
  await page
    .getByRole("row")
    .filter({ hasText: "team-1" })
    .getByText("Running")
    .waitFor({ timeout: STEP_TIMEOUT });
  await page
    .getByRole("row")
    .filter({ hasText: "team-2" })
    .getByText("Running")
    .waitFor({ timeout: STEP_TIMEOUT });
}

async function startEvent(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Schedule" }).click();
  await page.getByRole("button", { name: "Start now" }).click();
  await page.getByText("Scoring", { exact: true }).first().waitFor({ timeout: STEP_TIMEOUT });
}

async function captureFailure(page: Page, filename: string): Promise<void> {
  try {
    await page.screenshot({ path: join(artifacts, filename), fullPage: true });
  } catch (error) {
    console.error("Could not capture the browser failure:", error);
  }
}

async function participantSolves(
  context: BrowserContext,
  info: HostInfo,
  teamKey: string,
): Promise<string> {
  const page = await context.newPage();
  try {
    return await solveAs(page, context, info, teamKey);
  } catch (error) {
    await captureFailure(page, `participant-${teamKey.slice(0, 6)}.png`);
    throw error;
  }
}

async function solveAs(
  page: Page,
  context: BrowserContext,
  info: HostInfo,
  teamKey: string,
): Promise<string> {
  await page.goto(`${info.participant}/login#invite=${encodeURIComponent(teamKey)}`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: STEP_TIMEOUT });
  await page.goto(`${info.participant}/problems`);
  await page
    .getByText(/Staff-Only Login|スタッフ専用ログイン|SQL injection exercise/u)
    .first()
    .click();
  // "Access URLs → Web": a one-use handoff to this team's own exercise gateway.
  const web = page.locator('a[href*="/__join?ticket="]').first();
  await web.waitFor({ timeout: STEP_TIMEOUT });
  const exerciseUrl = await web.getAttribute("href");
  assert.ok(exerciseUrl, "The portal shows this team's exercise link.");
  const exercise = await context.newPage();
  await exercise.goto(exerciseUrl);
  // Participant-visible route: the exercise's own login form, not a verifier or repository file.
  await exercise.locator('input[name="username"]').fill("admin' --");
  await exercise.locator('input[name="password"]').fill("anything");
  await exercise.getByRole("button", { name: /Sign in|ログイン/u }).click();
  const flag = /TC\{[^}]+\}/u.exec(await exercise.locator("body").innerText())?.[0];
  assert.ok(flag, "The exercise reveals the admin flag.");
  await exercise.close();
  await page.getByLabel(/Flag/u).first().fill(flag);
  await page
    .getByRole("button", { name: /Submit flag/u })
    .first()
    .click();
  await page
    .getByText(/Correct!/u)
    .first()
    .waitFor({ timeout: STEP_TIMEOUT });
  await page.goto(`${info.participant}/scoreboard`);
  // The ranking lists both teams; this team's own row carries its award.
  const ranking = page.getByRole("row");
  await ranking.filter({ hasText: "team-1" }).first().waitFor({ timeout: STEP_TIMEOUT });
  await ranking.filter({ hasText: "team-2" }).first().waitFor({ timeout: STEP_TIMEOUT });
  await ranking.filter({ hasText: "(you)" }).getByText("100 pt").waitFor({ timeout: STEP_TIMEOUT });
  return flag;
}

async function endAndTearDown(page: Page): Promise<void> {
  await page.getByRole("button", { name: "End Event" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "End", exact: true }).click();
  await page.getByRole("tab", { name: "Schedule" }).click();
  await page.getByText("Ended", { exact: true }).first().waitFor({ timeout: STEP_TIMEOUT });
  await page.getByRole("button", { name: "Teardown now" }).click();
  await page.getByTestId("modal-teardown-confirm-input").locator("input").fill("DELETE");
  await page.getByTestId("modal-teardown-confirm").click();
  await page.getByRole("tab", { name: "Teams" }).click();
  for (const slug of ["team-1", "team-2"])
    await page
      .getByRole("row")
      .filter({ hasText: slug })
      .getByText("Removed")
      .waitFor({ timeout: STEP_TIMEOUT });
}

async function main(): Promise<void> {
  mkdirSync(artifacts, { recursive: true });
  const { info, child } = await startHost();
  let browser: Browser | undefined;
  let organizer: Page | undefined;
  const failures: unknown[] = [];
  try {
    browser = await chromium.launch({ executablePath: chromiumPath() });
    const admin = await browser.newContext({ locale: "en-US" });
    admin.setDefaultTimeout(STEP_TIMEOUT);
    organizer = await admin.newPage();
    await signInOrganizer(organizer, info);
    // A page navigation drops the memory-only token; the second sign-in uses the password.
    await signInOrganizer(organizer, info);
    const keys = await createEvent(organizer, "Browser rehearsal");
    await waitForReady(organizer);
    await startEvent(organizer);
    // Two independent participant browsers (separate cookies and storage).
    const [teamOne, teamTwo] = await Promise.all([
      browser.newContext({ locale: "en-US" }),
      browser.newContext({ locale: "en-US" }),
    ]);
    teamOne.setDefaultTimeout(STEP_TIMEOUT);
    teamTwo.setDefaultTimeout(STEP_TIMEOUT);
    const [flagOne, flagTwo] = await Promise.all([
      participantSolves(teamOne, info, keys.get("team-1") ?? ""),
      participantSolves(teamTwo, info, keys.get("team-2") ?? ""),
    ]);
    assert.notEqual(flagOne, flagTwo, "Each team has its own environment and flag.");
    await organizer.getByRole("tab", { name: "Scoreboard" }).click();
    await endAndTearDown(organizer);
  } catch (error) {
    failures.push(error);
    if (organizer) await captureFailure(organizer, "organizer-failure.png");
  } finally {
    for (const close of [() => browser?.close(), () => stopHost(child)]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length > 0) {
    for (const error of failures.slice(1))
      console.error("Additional fixture cleanup failure:", error);
    throw failures[0];
  }
  console.log(
    `PASS local competition browser rehearsal (${info.engine === "docker" ? "real Docker exercise" : "test-only exercise adapter, not Docker"})`,
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
