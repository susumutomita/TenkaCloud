import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { parseGatewayPorts } from "../gateway-ports";
import { type RunningLocalHost, startLocalHost } from "../server";
import type { HostStore } from "../store";
import { createTemporaryDirectory, removeTemporaryDirectory } from "../temporary-directory";
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
async function toggleAudit(page: Page, enabled: boolean, status = 200) {
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  const response = page.waitForResponse(
    (result) =>
      new URL(result.url()).pathname === "/api/feature-flags" &&
      result.request().method() === "PUT",
  );
  await page.getByRole("checkbox", { name: "audit", exact: true }).click();
  assert.equal((await response).status(), status);
  await page.getByRole("checkbox", { name: "audit", exact: true, checked: enabled }).waitFor();
}
async function main() {
  const data = createTemporaryDirectory(root, "tenka-audit-browser-");
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
    const key = host.organizerKey;
    assert.ok(key, "The fresh host provides its organizer key.");
    browser = await chromium.launch({ executablePath: chromiumPath() });
    const context = await browser.newContext({ locale: "en-US", acceptDownloads: true });
    page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await signInOrganizer(page, { admin: host.admin.origin, key });
    await page.getByRole("link", { name: "Audit log", exact: true }).click();
    await page.getByText("Recording stopped", { exact: true }).waitFor();
    await page.getByText("該当する監査ログはありません", { exact: false }).waitFor();
    await toggleAudit(page, true);
    // Reauthentication is an audited operation whose request contains the organizer secret.
    await signInOrganizer(page, { admin: host.admin.origin, key });
    assert.ok(store);
    store.database.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON host_audit_records BEGIN SELECT RAISE(ABORT, 'unavailable'); END;",
    );
    // A failed audit write must also roll back a request to disable recording.
    await toggleAudit(page, true, 503);
    store.database.exec("DROP TRIGGER fail_audit");
    assert.equal(store.featureFlags().audit, true);
    await page.getByRole("link", { name: "Audit log", exact: true }).click();
    await page.getByText("Recording enabled", { exact: true }).waitFor();
    await page.getByText("Some audit records are missing", { exact: true }).waitFor();
    await page.getByRole("cell", { name: "organizer.login", exact: true }).waitFor();
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: "CSV エクスポート", exact: true }).click();
    const download = await downloadEvent;
    const downloaded = await download.path();
    assert.ok(downloaded);
    const csv = readFileSync(downloaded, "utf8");
    assert.ok(csv.includes("organizer.login"));
    assert.ok(csv.includes("host-key"));
    assert.ok(!csv.includes(key), "Audit CSV excludes the organizer key.");
    assert.ok(!csv.includes(host.masterKey), "Audit CSV excludes the internal signing key.");
    await toggleAudit(page, false);
    await page.getByRole("link", { name: "Audit log", exact: true }).click();
    await page.getByText("Recording stopped", { exact: true }).waitFor();
    await page.getByRole("cell", { name: "organizer.login", exact: true }).waitFor();
    const anonymous = await fetch(`${host.admin.origin}/api/admin/audit-log`);
    assert.equal(anonymous.status, 401);
    const otherSurface = await fetch(`${host.participant.origin}/api/admin/audit-log`);
    assert.equal(otherSurface.status, 404);
    assert.deepEqual(errors, []);
    mkdirSync(artifacts, { recursive: true });
    await page.screenshot({
      path: join(artifacts, "audit-stopped-with-history.png"),
      fullPage: true,
    });
    console.log(
      "PASS audit UI enable, key-login history, CSV secret exclusion, fail-closed settings, gap warning, OFF history and access boundaries (real HTTP/SQLite).",
    );
  } catch (error) {
    mkdirSync(artifacts, { recursive: true });
    await page?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true });
    throw error;
  } finally {
    await browser?.close();
    await host?.stop();
    removeTemporaryDirectory(root, data);
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
