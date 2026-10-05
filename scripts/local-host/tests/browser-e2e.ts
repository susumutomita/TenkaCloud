/**
 * Browser rehearsal of a local competition (Issue #3226), driven only through what the
 * organizer and participants see: the built host console and participant portal, served by
 * `e2e-host.ts` (production wiring over a temporary data directory).
 *
 * Organizer: key-only sign-in, event creation, deploy, and start.
 * Participants: two independent browser contexts sign in with their team keys, open their own
 * exercise through the portal link, obtain the flag through that exercise's login form, submit
 * it in the portal, and see the ranking. Organizer: end the event and tear the environments down.
 *
 * Requires a prior `bun run build:host`. Uses a preinstalled Chromium (PLAYWRIGHT_BROWSERS_PATH
 * or HOST_E2E_CHROMIUM); it never downloads browsers.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { type PrivateKeyProcess, spawnPrivateKeyProcess } from "../private-key-process";
import { signInOrganizer } from "./organizer-login";

interface HostInfo {
  admin: string;
  participant: string;
  key: string;
  engine: "fixture" | "docker";
}

const root = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = join(root, ".tenkacloud/host-e2e");
const reviewArtifacts = join(root, ".tenkacloud/host-ui-review");
const STEP_TIMEOUT = 90_000;

function chromiumPath(): string | undefined {
  const explicit = process.env.HOST_E2E_CHROMIUM;
  if (explicit) return explicit;
  const preinstalled = "/opt/pw-browsers/chromium";
  // Otherwise Playwright resolves its own browser under PLAYWRIGHT_BROWSERS_PATH.
  return existsSync(preinstalled) ? preinstalled : undefined;
}

async function startHost(): Promise<{ info: HostInfo; child: PrivateKeyProcess }> {
  const processHandle = spawnPrivateKeyProcess(
    [process.execPath, "run", "scripts/local-host/tests/e2e-host.ts"],
    {
      cwd: root,
      env: { ...process.env, HOST_E2E_KEY_FD: "3" },
    },
  );
  const { child, stdout, stderr, privateOutput } = processHandle;
  stderr.pipe(process.stderr);
  const publicLines = createInterface({ input: stdout });
  const privateLines = createInterface({ input: privateOutput });
  const ready = <T>(lines: ReturnType<typeof createInterface>, parse: (line: string) => T) =>
    new Promise<T>((accept, reject) => {
      void child.exited.then(
        (code) => reject(new Error(`Host exited early (${String(code)}).`)),
        reject,
      );
      lines.once("line", (line) => {
        try {
          accept(parse(line));
        } catch {
          reject(new Error("Host fixture readiness response is invalid."));
        }
      });
    });
  try {
    const [address, key] = await Promise.all([
      ready(publicLines, (line) => JSON.parse(line) as Omit<HostInfo, "key">),
      ready(privateLines, (line) => {
        if (!/^[A-Za-z0-9_-]{43}$/u.test(line))
          throw new Error("Host fixture organizer key is invalid.");
        return line;
      }),
    ]);
    return { info: { ...address, key }, child: processHandle };
  } catch (error) {
    await stopHost(processHandle);
    throw error;
  } finally {
    publicLines.close();
    privateLines.close();
    stdout.resume();
    privateOutput.resume();
  }
}

async function stopHost(processHandle: PrivateKeyProcess): Promise<void> {
  const { child } = processHandle;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const code = await processHandle.exited;
  if (code !== 0) {
    const status = child.signalCode ? `signal ${String(child.signalCode)}` : `code ${String(code)}`;
    throw new Error(
      `Browser fixture host exited with ${status}. Check stderr for retained SQLite ownership.`,
    );
  }
}

async function createEvent(
  page: Page,
  name: string,
  organizerKey: string,
): Promise<Map<string, string>> {
  // In-app navigation: the session lives in memory only, so a reload means signing in again.
  await page.getByRole("button", { name: "Create event" }).first().click();
  await page.getByLabel("Event name").fill(name);
  const count = page.getByLabel("Team count");
  await count.fill("999");
  assert.equal(await count.inputValue(), "40", "The team input is bounded before submission.");
  await count.fill("2");
  await page.getByTestId("problem-select").click();
  await page.getByRole("option", { name: /Staff-Only Login|スタッフ専用ログイン/u }).click();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByText("Local competition mode", { exact: true }).count(), 0);
  assert.equal(await page.getByText("Local competition event", { exact: true }).count(), 0);
  await captureVerifiedUi(page, "local-event-create.png", [organizerKey]);
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

async function waitForEnvironmentState(page: Page, expected: "Stopped" | "Running"): Promise<void> {
  await page.getByRole("tab", { name: "Teams" }).click();
  const panel = page.getByText("Problem environments per team").first();
  await panel.waitFor();
  await page
    .getByRole("row")
    .filter({ hasText: "team-1" })
    .getByText(expected)
    .waitFor({ timeout: STEP_TIMEOUT });
  await page
    .getByRole("row")
    .filter({ hasText: "team-2" })
    .getByText(expected)
    .waitFor({ timeout: STEP_TIMEOUT });
}

async function startEvent(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Schedule" }).click();
  await page.getByRole("button", { name: "Start now" }).click();
  await page.getByText("Scoring", { exact: true }).first().waitFor({ timeout: STEP_TIMEOUT });
}

/** Only reviewed, key-free checkpoints enter the CI review artifact. */
async function captureVerifiedUi(
  page: Page,
  filename: string,
  secrets: readonly string[],
): Promise<void> {
  assert.equal(await page.getByRole("dialog").count(), 0, "Do not capture credential dialogs.");
  assert.equal(
    await page.locator('input[type="password"], a[href*="/__join?ticket="]').count(),
    0,
    "Do not capture credentials or join links.",
  );
  const route = new URL(page.url());
  const parameters = [route.searchParams, new URLSearchParams(route.hash.slice(1))];
  assert.ok(
    !parameters.some((values) => values.has("invite") || values.has("ticket")),
    "Do not capture a secret-bearing route.",
  );
  const visible = [
    await page.locator("body").innerText(),
    ...(await page
      .locator("input, textarea")
      .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))),
  ].join("\n");
  assert.ok(
    !secrets.some((secret) => secret.length > 0 && visible.includes(secret)),
    "A review screenshot must not contain fixture secrets.",
  );
  assert.ok(
    !/TC\{|[A-Za-z0-9_-]{43}|(?:invite|ticket)=/u.test(visible),
    "A review screenshot must not contain keys, flags, or join tickets.",
  );
  await page.screenshot({ path: join(reviewArtifacts, filename), fullPage: true });
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
  teamSlug: "team-1" | "team-2",
): Promise<string> {
  const page = await context.newPage();
  try {
    return await solveAs(page, context, info, teamKey, teamSlug);
  } catch (error) {
    await captureFailure(page, `participant-${teamSlug}.png`);
    throw error;
  }
}

async function solveAs(
  page: Page,
  context: BrowserContext,
  info: HostInfo,
  teamKey: string,
  teamSlug: "team-1" | "team-2",
): Promise<string> {
  await page.goto(`${info.participant}/login#invite=${encodeURIComponent(teamKey)}`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: STEP_TIMEOUT });
  await page.goto(`${info.participant}/problems`);
  assert.equal(await page.getByRole("link", { name: "Course tracks", exact: true }).count(), 0);
  await page
    .getByText(/Staff-Only Login|スタッフ専用ログイン|SQL injection exercise/u)
    .first()
    .waitFor();
  if (teamSlug === "team-1")
    await captureVerifiedUi(page, "participant-competition.png", [info.key, teamKey]);
  await page
    .getByText(/Staff-Only Login|スタッフ専用ログイン|SQL injection exercise/u)
    .first()
    .click();
  if (info.engine === "docker") {
    assert.equal(
      await page.locator('a[href*="/__join?ticket="]').count(),
      0,
      "Preparation leaves the team's problem dormant until it requests Start / resume.",
    );
    await page.getByRole("button", { name: "Start / resume", exact: true }).click();
    await page
      .getByRole("button", { name: "Stop (keep data)", exact: true })
      .waitFor({ timeout: STEP_TIMEOUT });
  }
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
  if (teamSlug === "team-1")
    await captureVerifiedUi(page, "participant-scoreboard.png", [info.key, teamKey, flag]);
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
  mkdirSync(reviewArtifacts, { recursive: true });
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
    // A page navigation drops the memory-only token; the same organizer key signs in again.
    await signInOrganizer(organizer, info);
    assert.equal(await organizer.getByRole("link", { name: "Audit log", exact: true }).count(), 0);
    assert.equal(await organizer.getByRole("link", { name: "Settings", exact: true }).count(), 0);
    await organizer.getByRole("link", { name: "Problems", exact: true }).click();
    await organizer.getByRole("heading", { name: /Problem catalog/u }).waitFor();
    await organizer.getByRole("searchbox", { name: "Keyword", exact: true }).fill("sqli");
    await organizer.locator('a[href="/problems/sqli-demo"]').waitFor();
    await captureVerifiedUi(organizer, "local-catalog.png", [info.key]);
    await organizer.locator('a[href="/problems/sqli-demo"]').click();
    await organizer.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await organizer.getByRole("heading", { name: "Description", exact: true }).waitFor();
    await organizer.getByRole("heading", { name: "Learning goals", exact: true }).waitFor();
    await organizer.getByRole("button", { name: "Back to list", exact: true }).click();
    await organizer.getByRole("heading", { name: /Problem catalog/u }).waitFor();
    await organizer.getByRole("link", { name: "Events", exact: true }).click();
    const keys = await createEvent(organizer, "Browser rehearsal", info.key);
    await waitForEnvironmentState(organizer, info.engine === "docker" ? "Stopped" : "Running");
    await startEvent(organizer);
    // Two independent participant browsers (separate cookies and storage).
    const [teamOne, teamTwo] = await Promise.all([
      browser.newContext({ locale: "en-US" }),
      browser.newContext({ locale: "en-US" }),
    ]);
    teamOne.setDefaultTimeout(STEP_TIMEOUT);
    teamTwo.setDefaultTimeout(STEP_TIMEOUT);
    const [flagOne, flagTwo] = await Promise.all([
      participantSolves(teamOne, info, keys.get("team-1") ?? "", "team-1"),
      participantSolves(teamTwo, info, keys.get("team-2") ?? "", "team-2"),
    ]);
    assert.notEqual(flagOne, flagTwo, "Each team has its own environment and flag.");
    await waitForEnvironmentState(organizer, "Running");
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
