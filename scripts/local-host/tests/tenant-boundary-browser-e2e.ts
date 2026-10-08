/** Native organizer -> two authenticated seats -> signed ranking -> process restart.
 * All game moves use visible Portal controls. Operation requests are observed only
 * for exact transport retry; no private state, reducer, fixture seeding or oracle.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { type PrivateKeyProcess, spawnPrivateKeyProcess } from "../private-key-process";
import { createTemporaryDirectory, removeTemporaryDirectory } from "../temporary-directory";
import { signInOrganizer } from "./organizer-login";

interface HostInfo {
  admin: string;
  participant: string;
  key: string;
  engine: "coordination";
}
const root = fileURLToPath(new URL("../../../", import.meta.url));
const STEP_TIMEOUT = 30_000;
async function startHost(
  data: string,
  previous?: HostInfo,
): Promise<{ info: HostInfo; child: PrivateKeyProcess }> {
  const processHandle = spawnPrivateKeyProcess(
    [process.execPath, "run", "scripts/local-host/tests/native-browser-host.ts"],
    {
      cwd: root,
      env: {
        ...process.env,
        HOST_E2E_KEY_FD: "3",
        HOST_NATIVE_DATA: data,
        ...(previous
          ? {
              HOST_NATIVE_ADMIN_PORT: new URL(previous.admin).port,
              HOST_NATIVE_PARTICIPANT_PORT: new URL(previous.participant).port,
            }
          : {}),
      },
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
        if (line === "restored" && previous) return previous.key;
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

async function createEvent(page: Page, name: string): Promise<Map<string, string>> {
  // In-app navigation: the session lives in memory only, so a reload means signing in again.
  await page.getByRole("button", { name: "Create event" }).first().click();
  await page.getByLabel("Event name").fill(name);
  const count = page.getByLabel("Team count");
  await count.fill("999");
  assert.equal(await count.inputValue(), "40", "The team input is bounded before submission.");
  await count.fill("2");
  await page
    .getByTestId("problem-select")
    .getByRole("checkbox", { name: /Tenant Boundary Duel|テナント境界防衛戦/u })
    .check();

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

const board = (page: Page) => page.locator(".tenant-duel");
const repair =
  'actor.active && ((actor.tenant == document.tenant && (action == "read" || actor.role == "editor")) || (action == "read" && grant.valid))';
const detector =
  'event.allowed && event.actorTenant != event.documentTenant && !(event.action == "read" && event.grantValid)';
const button = (page: Page, name: string) => board(page).getByRole("button", { name, exact: true });
const visible = (page: Page, text: string) =>
  board(page).getByText(text, { exact: true }).first().waitFor();

async function login(page: Page, info: HostInfo, key: string) {
  await page.goto(`${info.participant}/login#invite=${encodeURIComponent(key)}`);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.goto(`${info.participant}/problems`);
  await page.getByText("Tenant Boundary Duel", { exact: true }).first().click();
  await board(page).getByRole("heading", { name: "Tenant Boundary Duel", exact: true }).waitFor();
}

async function safeCapture(page: Page, path: string, secrets: string[]) {
  const text = await page.locator("body").innerText();
  assert(!secrets.some((secret) => text.includes(secret)));
  assert(!new URL(page.url()).hash.includes("invite="));
  await page.screenshot({ path, fullPage: false });
}

async function lostResponse(page: Page) {
  let drop = true;
  const bodies: string[] = [];
  await page.route("**/api/portal/me/coordination/op", async (route) => {
    const payload = route.request().postData();
    if (!payload) throw new Error("Operation body missing");
    bodies.push(payload);
    assert.equal(typeof (JSON.parse(payload) as { runId: unknown }).runId, "string");
    if (drop) {
      drop = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await button(page, "Read").click();
  await button(page, "Retry same operation").click();
  await page.unroute("**/api/portal/me/coordination/op");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
}

async function playRound(first: Page, second: Page, round: number) {
  await visible(first, "Compare action and evidence");
  await visible(second, "Compare action and evidence");
  const attacker = (await board(first).locator(".td-stage").innerText()).includes("Attacker")
    ? first
    : second;
  const defender = attacker === first ? second : first;
  if (round === 1) await lostResponse(attacker);
  else await button(attacker, "Read").click();
  await visible(attacker, "read · allowed=true · damage=+25");
  await button(attacker, "Hand over evidence").click();
  await visible(defender, "Implement authorization and detection");
  if (round === 1) {
    await board(defender).getByLabel("Authorization expression", { exact: true }).fill("false");
    await button(defender, "Public tests").click();
    await visible(defender, "FAIL · active reader blue → blue read");
  }
  await board(defender).getByLabel("Authorization expression", { exact: true }).fill(repair);
  await board(defender).getByLabel("Detection expression", { exact: true }).fill(detector);
  await button(defender, "Public tests").click();
  await visible(defender, "PASS · allowed cross-tenant read, no grant → alert");
  await button(defender, "Deploy repair and retest").click();
  await visible(attacker, "Retest");
  await board(attacker).getByLabel("Claimed tenant").selectOption("orange");
  await button(attacker, "Read").click();
  await visible(attacker, "read · allowed=false · damage=0");
  if (round === 3) {
    const option = board(attacker)
      .getByLabel("Target document")
      .locator("option")
      .filter({ hasText: "Shared reading copy" });
    await board(attacker)
      .getByLabel("Target document")
      .selectOption((await option.getAttribute("value")) ?? "");
    await button(attacker, "Read").click();
    await visible(attacker, "read · allowed=true · damage=0");
    await button(attacker, "Edit").click();
    await visible(attacker, "edit · allowed=false · damage=0");
  }
  await visible(
    defender,
    round === 3 ? "edit · allowed=false · damage=0" : "read · allowed=false · damage=0",
  );
  await button(defender, "Recheck work, boundaries and detection").click();
  await visible(attacker, "Safety 48/48 · Work 16/16 · Detection 128/128 · PASS");
  await button(attacker, "Finish attack retest").click();
  await board(first)
    .getByText(new RegExp(`R${String(round)} ·`))
    .first()
    .waitFor();
}

async function checkOfficialHistory(page: Page, info: HostInfo, output: string, secrets: string[]) {
  await page.goto(`${info.participant}/scoreboard`);
  const rows = page.getByRole("row");
  await rows.filter({ hasText: "team-1" }).first().waitFor();
  await rows.filter({ hasText: "team-2" }).first().waitFor();
  assert.match(await rows.filter({ hasText: "(you)" }).innerText(), /200\s*pt/u);
  await safeCapture(page, join(output, "official-ranking.png"), secrets);
  await page.goto(`${info.participant}/score-events`);
  await page.getByRole("heading", { name: "Score events", exact: true }).waitFor();
  await page.getByRole("row").filter({ hasText: "+100 pt" }).first().waitFor();
  await safeCapture(page, join(output, "official-history.png"), secrets);
}

async function main(): Promise<void> {
  const data = createTemporaryDirectory(root, "tenant-duel-browser-");
  const output = join(root, ".tenkacloud/host-ui-review/tenant-boundary-duel");
  mkdirSync(output, { recursive: true });
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  let browser: Browser | undefined;
  try {
    host = await startHost(data);
    browser = await chromium.launch({ executablePath: process.env.HOST_E2E_CHROMIUM });
    const errors: string[] = [];
    const options = { locale: "en-US", viewport: { width: 1280, height: 900 } };
    function observe(page: Page) {
      page.setDefaultTimeout(STEP_TIMEOUT);
      page.on("pageerror", (e) => errors.push(e.message));
      return page;
    }
    const admin = observe(await browser.newPage(options));
    let first = observe(await browser.newPage(options)),
      second = observe(await browser.newPage(options));
    await signInOrganizer(admin, host.info);
    const keys = await createEvent(admin, "Tenant authorization practice");
    await startEvent(admin);
    const key1 = keys.get("team-1"),
      key2 = keys.get("team-2");
    if (!key1 || !key2) throw new Error("Two native keys absent");
    const secrets = [host.info.key, key1, key2];
    await login(first, host.info, key1);
    await login(second, host.info, key2);
    await button(first, "Ready").click();
    await visible(second, "Ready seats: 1 / 2");
    await button(second, "Ready").click();
    await playRound(first, second, 1);
    const before = await board(first).locator(".td-scores").innerText();
    const previous = host.info;
    await first.context().close();
    await second.context().close();
    await stopHost(host.child);
    host = await startHost(data, previous);
    first = observe(await browser.newPage(options));
    second = observe(await browser.newPage(options));
    await login(first, host.info, key1);
    await login(second, host.info, key2);
    assert.equal(await board(first).locator(".td-scores").innerText(), before);
    await board(first).getByText(/R1 ·/u).first().waitFor();
    for (let round = 2; round <= 4; round++) await playRound(first, second, round);
    await visible(first, "Match finished");
    await visible(second, "Match finished");
    assert.equal(await board(first).getByText("200 pt", { exact: true }).count(), 2);
    await safeCapture(first, join(output, "replay-en.png"), secrets);
    await first.getByText("English", { exact: true }).filter({ visible: true }).click();
    await first.getByTestId("ja").click();
    await visible(first, "試合終了");
    await first.setViewportSize({ width: 390, height: 844 });
    await first.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
    assert.equal(
      await first.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await board(first).getByText("試合終了", { exact: true }).scrollIntoViewIfNeeded();
    await safeCapture(first, join(output, "replay-ja-mobile.png"), secrets);
    await checkOfficialHistory(second, host.info, output, secrets);
    assert.deepEqual(errors, []);
    console.log(
      "PASS organizer selection; two authenticated seats; visible code repair and delegation; exact retry with runId; process restart restores scores/history; four rounds, JA/EN, 390px, official 200–200 ranking and score events",
    );
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        if (host) await stopHost(host.child);
      } finally {
        removeTemporaryDirectory(root, data);
      }
    }
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
