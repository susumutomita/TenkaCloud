/**
 * Real organizer Start and participant refresh regression over temporary SQLite.
 * Run after build:host with HOST_E2E_ENGINE=coordination and a preinstalled Chromium.
 * Two participant contexts stay mounted before Start: one manually refreshes,
 * the other uses the existing 30-second automatic refresh. No Docker or AWS.
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
  engine: "fixture" | "docker" | "coordination";
}

const root = fileURLToPath(new URL("../../../", import.meta.url));
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
  await page.getByRole("option", { name: /ac26-crypto-battle/u }).click();
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

async function startEvent(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Schedule" }).click();
  await page.getByRole("button", { name: "Start now" }).click();
  await page.getByText("Scoring", { exact: true }).first().waitFor({ timeout: STEP_TIMEOUT });
}

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

async function waitBeforeStart(
  context: BrowserContext,
  info: HostInfo,
  key: string,
  automatic: boolean,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${info.participant}/login#invite=${encodeURIComponent(key)}`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.goto(`${info.participant}/problems`);
  await page
    .getByText(/Cryptography Battle|暗号バトル/u)
    .first()
    .click();
  await page.getByText("Competition not started yet", { exact: true }).waitFor();
  if (automatic) await page.getByRole("button", { name: "Auto refresh: Off", exact: true }).click();
  await captureVerifiedUi(
    page,
    automatic ? "participant-before-start-auto.png" : "participant-before-start-manual.png",
    [info.key, key],
  );
  return page;
}

async function assertStarted(page: Page, automatic: boolean): Promise<void> {
  const response = page.waitForResponse(
    (result) => result.url().endsWith("/portal/me") && result.status() === 200,
  );
  if (!automatic) await page.getByRole("button", { name: "Refresh latest", exact: true }).click();
  const payload = await (await response).json();
  console.log(
    `${automatic ? "Automatic" : "Manual"} participant API gate=${payload.eventGate.kind}`,
  );
  assert.equal(
    payload.eventGate.kind,
    "ok",
    "The production participant API reflects organizer Start.",
  );
  await page
    .getByText("Competition not started yet", { exact: true })
    .waitFor({ state: "hidden", timeout: 40_000 });

  // Native runtime has no access ticket; validate the entire visible frame before saving.
  await captureVerifiedUi(
    page,
    automatic ? "participant-after-start-auto.png" : "participant-after-start-manual.png",
    [],
  );
  await page.close();
}

async function main(): Promise<void> {
  mkdirSync(reviewArtifacts, { recursive: true });
  const { info, child } = await startHost();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: chromiumPath() });
    const admin = await browser.newContext({ locale: "en-US" });
    const organizer = await admin.newPage();
    await signInOrganizer(organizer, info);
    const keys = await createEvent(organizer, "Start refresh rehearsal", info.key);
    const manualContext = await browser.newContext({ locale: "en-US" });
    const automaticContext = await browser.newContext({ locale: "en-US" });
    const [manual, automatic] = await Promise.all([
      waitBeforeStart(manualContext, info, keys.get("team-1") ?? "", false),
      waitBeforeStart(automaticContext, info, keys.get("team-2") ?? "", true),
    ]);
    console.log("Waiting participant pages ready; starting through organizer UI.");
    await startEvent(organizer);
    console.log("Organizer Start completed.");
    await Promise.all([assertStarted(manual, false), assertStarted(automatic, true)]);
    console.log(
      "PASS real organizer Start -> participant API gate=ok -> manual and automatic UI unlock (native runtime, temporary SQLite, no Docker/AWS)",
    );
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    try {
      await browser?.close();
    } finally {
      await stopHost(child);
    }
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
