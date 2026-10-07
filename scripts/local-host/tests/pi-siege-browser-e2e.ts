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
    .getByRole("checkbox", { name: /Pi Siege|π包囲戦/u })
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

const board = (p: Page) => p.locator(".pi-root");
const button = (p: Page, name: string) => board(p).getByRole("button", { name, exact: true });
const visible = (p: Page, text: string) =>
  board(p).getByText(text, { exact: false }).first().waitFor();
const feedback = (p: Page, text: string) =>
  board(p).locator(".pi-feedback").getByText(text, { exact: false }).first().waitFor();
const pass = async (p: Page) => {
  await button(p, "Finish this round (unused tickets do not carry over)").click();
};
const publish = async (p: Page) => {
  await button(p, "Publish claim (one ticket)").click();
  await feedback(p, "Claim published.");
};
const audit = async (p: Page) => {
  await button(p, "Audit counterexample or insufficient evidence (one ticket)").click();
  await feedback(p, "Audit succeeds. +4");
};
const trial = async (p: Page, name: string, result: string) => {
  await button(p, `${name} (one ticket)`).click();
  await feedback(p, result);
};
const table = async (p: Page, cells: string[]) => {
  for (const [i, cell] of cells.entries())
    await board(p)
      .getByRole("textbox", { name: `Cell ${i + 1}`, exact: true })
      .fill(cell);
};
async function login(page: Page, info: HostInfo, key: string) {
  try {
    await page.goto(`${info.participant}/login#invite=${encodeURIComponent(key)}`);
  } catch {
    throw new Error("Could not open participant login");
  }
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.goto(`${info.participant}/problems`);
  await page.getByText("Pi Siege", { exact: true }).first().click();
  await board(page).getByRole("heading", { name: "Pi Siege", exact: true }).waitFor();
}
async function safeCapture(page: Page, path: string, secrets: string[]) {
  const text = await page.locator("body").innerText();
  assert(!secrets.some((secret) => text.includes(secret)));
  assert(!/[A-Za-z0-9_-]{43}/u.test(text));
  assert(!new URL(page.url()).hash.includes("invite="));
  await page.screenshot({ path, fullPage: false });
}
async function main(): Promise<void> {
  const data = createTemporaryDirectory(root, "tenka-native-browser-");
  const output = join(root, ".tenkacloud/host-ui-review/pi-siege");
  mkdirSync(output, { recursive: true });
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  let browser: Browser | undefined;
  try {
    host = await startHost(data);
    browser = await chromium.launch({ executablePath: process.env.HOST_E2E_CHROMIUM });
    const errors: string[] = [];
    const pageOptions = { locale: "en-US", viewport: { width: 1280, height: 900 } };
    const admin = await browser.newPage(pageOptions);
    const first = await browser.newPage(pageOptions),
      second = await browser.newPage(pageOptions);
    for (const p of [admin, first, second]) {
      p.setDefaultTimeout(STEP_TIMEOUT);
      p.on("pageerror", (e) => errors.push(e.message));
    }
    await signInOrganizer(admin, host.info);
    const keys = await createEvent(admin, "Pi native browser");
    await startEvent(admin);
    const key1 = keys.get("team-1"),
      key2 = keys.get("team-2");
    if (!key1 || !key2) throw new Error("Two native team keys absent");
    await login(first, host.info, key1);
    await login(second, host.info, key2);
    await button(first, "Ready").click();
    await visible(second, "opponent: Ready");
    await button(second, "Ready").click();
    await visible(first, "ROUND 1");
    await visible(second, "ROUND 1");
    // Determine the first seat from participant-visible turn text; host ULIDs are randomized.
    let a = (await board(first).locator(".pi-turn").innerText()).startsWith("Your turn")
        ? first
        : second,
      b = a === first ? second : first;
    const alphaKey = a === first ? key1 : key2,
      bravoKey = b === first ? key1 : key2;
    console.log("Native browser: organizer selected Pi Siege; two authenticated seats; round 1");
    await board(a).getByText("Free rules and a small example", { exact: true }).click();
    await visible(a, "With q=5");
    let drop = true;
    const submitted: string[] = [];
    await a.route("**/api/portal/me/coordination/op", async (route) => {
      const payload = route.request().postData();
      if (!payload) throw new Error("Native operation request body is absent");
      submitted.push(payload);
      if (drop) {
        drop = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await button(a, "Expand denominators to 120 (one ticket)").click();
    await visible(a, "The response was lost.");
    await button(a, "Resend the same operation").click();
    await feedback(a, "Denominator range expanded to 120");
    assert.equal(submitted.length, 2);
    assert.equal(submitted[0], submitted[1]);
    await a.unroute("**/api/portal/me/coordination/op");
    await trial(b, "Try a fraction", "3/1: approximate error");
    await board(a).getByRole("spinbutton", { name: "Numerator p", exact: true }).fill("355");
    await board(a).getByRole("spinbutton", { name: "Denominator q", exact: true }).fill("113");
    await trial(a, "Try a fraction", "this one record beats");
    assert.equal(await board(b).getByText("355/113", { exact: false }).count(), 0);
    // A separate host process now reloads the same persisted SQLite directory.
    const before = await board(a).locator(".pi-scoreboard").innerText();
    const previous = host.info;
    // Fresh browser contexts require real team-key authentication after the restart.
    await a.context().close();
    await b.context().close();
    await stopHost(host.child);
    host = await startHost(data, previous);
    a = await browser.newPage(pageOptions);
    b = await browser.newPage(pageOptions);
    for (const p of [a, b]) {
      p.setDefaultTimeout(STEP_TIMEOUT);
      p.on("pageerror", (e) => errors.push(e.message));
    }
    await login(a, host.info, alphaKey);
    await login(b, host.info, bravoKey);
    await visible(a, "355/113: approximate error");
    assert.equal(await board(a).locator(".pi-scoreboard").innerText(), before);
    console.log("Native browser: process restart restores private experiment, tickets and scores");
    await board(b)
      .getByRole("combobox", { name: "Claim scope", exact: true })
      .selectOption("forever");
    await publish(b);
    await audit(a);
    await pass(b);
    await publish(a);
    await pass(a);
    await visible(b, "ROUND 2");
    await table(b, ["1", "1/2", "1", "5/8"]);
    await trial(b, "Try a table", "Difference of diagonal products = 1/8");
    await table(a, ["1", "1/2", "1", "1/2"]);
    await trial(a, "Try a table", "Difference of diagonal products = 0");
    await board(b).getByRole("textbox", { name: "Published floor", exact: true }).fill("1/64");
    await publish(b);
    await board(a).getByRole("textbox", { name: "Published floor", exact: true }).fill("1/16");
    await publish(a);
    await board(b)
      .getByRole("combobox", { name: "Audit reason", exact: true })
      .selectOption("zero");
    await audit(b);
    await pass(a);
    await pass(b);
    await visible(a, "ROUND 3");
    await trial(a, "Try an arrangement", "type sum + degree sum = 6");
    await board(b).getByRole("spinbutton", { name: "Trial type-1 count", exact: true }).fill("2");
    await trial(b, "Try an arrangement", "type sum + degree sum = 4");
    await board(a).getByRole("spinbutton", { name: "Published exponent", exact: true }).fill("6");
    await publish(a);
    await board(b)
      .getByRole("spinbutton", { name: "Counterexample type-1 count", exact: true })
      .fill("2");
    await board(b)
      .getByRole("spinbutton", { name: "Counterexample exponent", exact: true })
      .fill("4");
    await audit(b);
    await feedback(b, "does not establish that an actual term is nonzero or large");
    await button(a, "Increase to 5 rows (one ticket)").click();
    await feedback(a, "Increased row cards to 5");
    await board(b).getByRole("spinbutton", { name: "Published exponent", exact: true }).fill("4");
    await publish(b);
    await pass(a);
    await pass(b);
    await visible(b, "ROUND 4");
    await button(b, "Refine grid to 1/50 (one ticket)").click();
    await feedback(b, "grid refined to 1/50");
    await trial(a, "Try an allocation", "error ν(1−b)−1 = -1/10");
    await board(b)
      .getByRole("spinbutton", { name: "Allocation numerator", exact: true })
      .fill("27");
    await trial(b, "Try an allocation", "All four margins");
    await publish(a);
    await board(b)
      .getByRole("combobox", { name: "Audit reason", exact: true })
      .selectOption("error");
    await audit(b);
    await pass(a);
    await publish(b);
    await pass(b);
    await visible(a, "Match over · From a finite game");
    assert.match(
      await board(a).locator(".pi-scoreboard").innerText(),
      /1\s*points[\s\S]*27\s*points/u,
    );
    await board(a).getByText("Score and verdict history", { exact: true }).click();
    await safeCapture(a, join(output, "native-debrief-en.png"), [host.info.key, key1, key2]);
    await a.getByText("English", { exact: true }).filter({ visible: true }).click();
    await a.getByTestId("ja").click();
    await visible(a, "試合終了 · 有限の競技から論文へ");
    await a.setViewportSize({ width: 390, height: 844 });
    assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await board(a)
      .getByText("試合終了 · 有限の競技から論文へ", { exact: false })
      .first()
      .scrollIntoViewIfNeeded();
    await safeCapture(a, join(output, "native-debrief-ja-mobile.png"), [host.info.key, key1, key2]);
    await b.goto(`${host.info.participant}/scoreboard`);
    const rows = b.getByRole("row");
    await rows.filter({ hasText: "team-1" }).first().waitFor();
    await rows.filter({ hasText: "team-2" }).first().waitFor();
    assert.match(await rows.filter({ hasText: "(you)" }).innerText(), /27\s*pt/u);
    await safeCapture(b, join(output, "native-official-ranking.png"), [host.info.key, key1, key2]);
    await b.goto(`${host.info.participant}/score-events`);
    await b.getByRole("heading", { name: "Score events", exact: true }).waitFor();
    await b.getByRole("row").filter({ hasText: "+6 pt" }).first().waitFor();
    await b.getByRole("row").filter({ hasText: "+4 pt" }).first().waitFor();
    await safeCapture(b, join(output, "native-official-history.png"), [host.info.key, key1, key2]);
    assert.deepEqual(errors, []);
    console.log(
      "PASS native organizer selection, authenticated seats, private trial, exact retry, process restart, four rounds/eight claims, JA/EN, official 1–27 ranking, history, mobile and no page errors",
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
