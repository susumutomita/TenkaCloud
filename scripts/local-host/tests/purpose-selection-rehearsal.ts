/** Real catalog selection and SQLite event-save rehearsal; no Docker/AWS deployment or model download. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { type PrivateKeyProcess, spawnPrivateKeyProcess } from "../private-key-process";
import { organizerToken, signInOrganizer } from "./organizer-login";

interface HostInfo {
  admin: string;
  participant: string;
  key: string;
  engine: "fixture" | "docker" | "coordination";
}

const root = fileURLToPath(new URL("../../../", import.meta.url));
const reviewArtifacts = join(root, ".tenkacloud/host-ui-review");

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

async function main(): Promise<void> {
  mkdirSync(reviewArtifacts, { recursive: true });
  const { info, child } = await startHost();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: chromiumPath() });
    const context = await browser.newContext({
      locale: "en-US",
      viewport: { width: 1440, height: 1000 },
    });
    await context.addInitScript(() => {
      Reflect.deleteProperty(Navigator.prototype, "gpu");
    });
    const page = await context.newPage();
    assert.equal(await page.evaluate(() => "gpu" in navigator), false);
    const external: string[] = [];
    page.on("request", (request) => {
      if (!request.url().startsWith(info.admin) && !request.url().startsWith(info.participant))
        external.push(request.url());
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await signInOrganizer(page, info);
    const token = await organizerToken(info);
    await page.getByRole("button", { name: "Create event" }).first().click();
    await page.getByLabel("Event name").fill("Purpose selection rehearsal");
    await page.getByLabel("Team count").fill("1");
    await page.getByRole("button", { name: "問題選択のヘルプ", exact: true }).click();
    const query = page.getByRole("textbox", { name: "学びたいこと", exact: true });
    await query.fill("暗号を学びたい");
    const started = performance.now();
    await page.getByRole("button", { name: "候補を探す", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "公開情報に合う候補" }).waitFor();
    const elapsedMs = performance.now() - started;
    const list = page.getByTestId("problem-select");
    assert.ok((await list.getByRole("checkbox").count()) > 0);
    const selectable = list.getByRole("checkbox").filter({ visible: true });
    const selectedId = await selectable
      .first()
      .evaluate((input) =>
        input
          .closest("[data-testid^=problem-checkbox-]")
          ?.getAttribute("data-testid")
          ?.replace("problem-checkbox-", ""),
      );
    assert.ok(selectedId);
    await selectable.first().check();
    const selection = page.getByTestId("problem-selection");
    await selection.waitFor();
    assert.equal(await list.getByRole("checkbox").first().isChecked(), true);
    await query.fill("宇宙旅行ZZZ");
    await page.getByRole("button", { name: "候補を探す", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "見つかりませんでした" }).waitFor();
    assert.equal(await list.getByRole("checkbox").count(), 0);
    assert.ok(await selection.innerText());
    await page.getByRole("button", { name: "目的による絞り込みを解除" }).click();
    assert.ok((await list.getByRole("checkbox").count()) > 10);
    assert.equal(
      await page.getByTestId(`problem-checkbox-${selectedId}`).getByRole("checkbox").isChecked(),
      true,
    );
    const catalogResponse = await fetch(`${info.admin}/api/host/catalog`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const catalog = (await catalogResponse.json()) as {
      items: { problemId: string; runtime: string }[];
    };
    const battles = catalog.items.filter((item) => item.runtime === "coordination");
    const [first, second] = battles;
    assert.ok(first && second);
    const firstBattle = page
      .getByTestId(`problem-checkbox-${first.problemId}`)
      .getByRole("checkbox");
    const secondBattle = page
      .getByTestId(`problem-checkbox-${second.problemId}`)
      .getByRole("checkbox");
    await firstBattle.check();
    assert.equal(await secondBattle.isDisabled(), true);
    assert.ok(await page.getByTestId("coordination-selection-help").innerText());
    await firstBattle.uncheck();
    assert.equal(await secondBattle.isEnabled(), true);
    assert.equal(
      await page.getByTestId(`problem-checkbox-${selectedId}`).getByRole("checkbox").isChecked(),
      true,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await captureVerifiedUi(page, "purpose-selection-mobile.png", [info.key, token]);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    );
    await page.getByRole("button", { name: "Create Event", exact: true }).click();
    const modal = page.getByRole("dialog");
    await modal.getByText("Save these login keys now").waitFor();
    await modal.getByRole("button", { name: "Later", exact: true }).click();
    await page.waitForURL(/\/events\/[0-9A-Z]{26}$/u);
    const events = await fetch(`${info.admin}/api/events`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await events.json();
    assert.ok(JSON.stringify(body).includes("Purpose selection rehearsal"));
    const detail = await fetch(
      `${info.admin}/api/events/${new URL(page.url()).pathname.split("/").at(-1)}`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    assert.equal(detail.status, 200);
    const saved = (await detail.json()) as { problems: { problemId: string }[] };
    assert.deepEqual(
      saved.problems.map((problem) => problem.problemId),
      [selectedId],
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(
      JSON.stringify({
        pass: true,
        catalogCount: catalog.items.length,
        elapsedMs,
        condition:
          "headless Chromium, WebGPU removed, real catalog, no model preparation, click to rendered results",
        externalRequests: external.length,
      }),
    );
  } finally {
    await browser?.close();
    await stopHost(child);
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
