import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { randomToken } from "../auth";
import { parseGatewayPorts } from "../gateway-ports";
import { type RunningLocalHost, startLocalHost } from "../server";
import type { HostStore } from "../store";
import { ExerciseFixture } from "./exercise-fixture";
import { signInOrganizer } from "./organizer-login";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = join(root, ".tenkacloud/host-audit-e2e");
function chromiumPath(): string | undefined {
  if (process.env.HOST_E2E_CHROMIUM) return process.env.HOST_E2E_CHROMIUM;
  return [
    "/opt/pw-browsers/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find(existsSync);
}
async function toggleAudit(page: Page, enabled: boolean) {
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  const response = page.waitForResponse(
    (result) =>
      new URL(result.url()).pathname === "/api/feature-flags" &&
      result.request().method() === "PUT",
  );
  await page.getByRole("checkbox", { name: "audit", exact: true }).click();
  assert.equal((await response).status(), 200);
  await page.getByRole("checkbox", { name: "audit", exact: true, checked: enabled }).waitFor();
}
async function addViewer(page: Page, username: string, password: string, status: number) {
  await page.getByRole("link", { name: "Users", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password (at least 12 characters)", { exact: true }).fill(password);
  await page.getByLabel("New user role", { exact: true }).selectOption("Viewer");
  const response = page.waitForResponse(
    (result) =>
      new URL(result.url()).pathname === "/api/host/users" && result.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add", exact: true }).click();
  assert.equal((await response).status(), status);
}
async function main() {
  const data = mkdtempSync(join(tmpdir(), "tenka-audit-browser-"));
  const secret = randomToken();
  let browser: Browser | undefined;
  let page: Page | undefined;
  let host: RunningLocalHost | undefined;
  let store: HostStore | undefined;
  const errors: string[] = [];
  try {
    host = await startLocalHost(
      root,
      {
        dataDirectory: data,
        hostname: "127.0.0.1",
        adminPort: 0,
        participantPort: 0,
        gatewayPorts: parseGatewayPorts("5650-5689"),
      },
      (_directory, database) => {
        store = database;
        return new ExerciseFixture((path) => new Database(path));
      },
      () => undefined,
    );
    browser = await chromium.launch({ executablePath: chromiumPath() });
    const context = await browser.newContext({ locale: "en-US", acceptDownloads: true });
    page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await signInOrganizer(
      page,
      { admin: host.admin.origin, key: host.masterKey },
      { username: "local-admin", password: secret },
    );
    await page.getByRole("link", { name: "Audit log", exact: true }).click();
    await page.getByText("Recording stopped", { exact: true }).waitFor();
    await page.getByText("該当する監査ログはありません", { exact: false }).waitFor();
    await toggleAudit(page, true);
    await addViewer(page, "audit-viewer", secret, 201);
    assert.ok(store);
    store.database.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON host_audit_records BEGIN SELECT RAISE(ABORT, 'unavailable'); END;",
    );
    await addViewer(page, "blocked-viewer", randomToken(), 503);
    store.database.exec("DROP TRIGGER fail_audit");
    assert.equal(
      store.organizers().some((user) => user.username === "blocked-viewer"),
      false,
    );
    await page.getByRole("link", { name: "Audit log", exact: true }).click();
    await page.getByText("Recording enabled", { exact: true }).waitFor();
    await page.getByText("Some audit records are missing", { exact: true }).waitFor();
    await page.getByRole("cell", { name: "organizer.created", exact: true }).waitFor();
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: "CSV エクスポート", exact: true }).click();
    const download = await downloadEvent;
    const downloaded = await download.path();
    assert.ok(downloaded);
    const csv = readFileSync(downloaded, "utf8");
    assert.ok(csv.includes("organizer.created"));
    assert.ok(!csv.includes(secret));
    assert.ok(!csv.includes(host.masterKey));
    await toggleAudit(page, false);
    await page.getByRole("link", { name: "Audit log", exact: true }).click();
    await page.getByText("Recording stopped", { exact: true }).waitFor();
    await page.getByRole("cell", { name: "organizer.created", exact: true }).waitFor();
    const viewer = await (await browser.newContext({ locale: "en-US" })).newPage();
    await signInOrganizer(
      viewer,
      { admin: host.admin.origin, key: host.masterKey },
      { username: "audit-viewer", password: secret },
    );
    assert.equal(await viewer.getByRole("link", { name: "Audit log", exact: true }).count(), 0);
    await viewer.goto(`${host.admin.origin}/audit-log`);
    await viewer.locator("#organizer-username").fill("audit-viewer");
    await viewer.locator("#organizer-password").fill(secret);
    const denied = viewer.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/admin/audit-log",
    );
    await viewer.getByRole("button", { name: "Sign in", exact: true }).click();
    assert.equal((await denied).status(), 403);
    await viewer.getByText("監査ログを閲覧できる管理者ロールが必要です", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    mkdirSync(artifacts, { recursive: true });
    await page.screenshot({
      path: join(artifacts, "audit-stopped-with-history.png"),
      fullPage: true,
    });
    console.log(
      "PASS audit UI enable, operation history, CSV secret exclusion, gap warning, OFF history and Viewer denial (real HTTP/SQLite).",
    );
  } catch (error) {
    mkdirSync(artifacts, { recursive: true });
    await page?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true });
    throw error;
  } finally {
    await browser?.close();
    await host?.stop();
    rmSync(data, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
