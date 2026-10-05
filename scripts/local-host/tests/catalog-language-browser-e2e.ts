/** Authenticated catalog language rehearsal. Reads all real problem metadata but never creates an event or starts Docker/AWS. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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

async function switchLanguage(page: Page, current: string, next: string): Promise<void> {
  await page.getByText(current, { exact: true }).filter({ visible: true }).click();
  await page.getByText(next, { exact: true }).filter({ visible: true }).click();
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
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await signInOrganizer(page, info);
    const token = await organizerToken(info);
    const response = await fetch(`${info.admin}/api/host/catalog`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const payload = (await response.json()) as {
      items: { problemId: string; content?: { i18n?: { en?: { description?: string } } } }[];
    };
    const metadata = JSON.parse(
      readFileSync(join(root, "problems/challenges/ac26-w1-constraint-lab/metadata.json"), "utf8"),
    );
    assert.equal(
      payload.items.find((item) => item.problemId === metadata.id)?.content?.i18n?.en?.description,
      metadata.i18n.en.description,
    );
    await page.getByRole("link", { name: "Problems", exact: true }).click();
    await page.getByRole("searchbox", { name: "Keyword", exact: true }).fill(metadata.id);
    await page.getByText(metadata.i18n.en.name, { exact: true }).waitFor();
    assert.ok((await page.locator("body").innerText()).includes(metadata.i18n.en.shortDescription));
    await captureVerifiedUi(page, "catalog-english.png", [info.key, token]);
    await switchLanguage(page, "English", "日本語");
    await page.getByText(metadata.name, { exact: true }).waitFor();
    await captureVerifiedUi(page, "catalog-japanese.png", [info.key, token]);
    await switchLanguage(page, "日本語", "English");
    await page.getByText(metadata.i18n.en.name, { exact: true }).click();
    await page.getByRole("heading", { name: "Description", exact: true }).waitFor();
    assert.ok((await page.locator("body").innerText()).includes("Week 1's mechanism problem."));
    await captureVerifiedUi(page, "catalog-detail-english.png", [info.key, token]);
    await page.setViewportSize({ width: 390, height: 844 });
    await captureVerifiedUi(page, "catalog-detail-english-mobile.png", [info.key, token]);
    assert.deepEqual(errors, []);
    console.log(
      "PASS real authenticated /host/catalog English projection and JA -> EN -> JA UI text; no event creation, Docker or AWS.",
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
