import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { parseGatewayPorts } from "../gateway-ports";
import { type RunningLocalHost, startLocalHost } from "../server";
import type { HostStore } from "../store";
import { createTemporaryDirectory, removeTemporaryDirectory } from "../temporary-directory";
import { ExerciseFixture } from "./exercise-fixture";
import { fillOrganizerKey, organizerToken, signInOrganizer } from "./organizer-login";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = join(root, ".tenkacloud/host-audit-e2e");
function chromiumPath(): string | undefined {
  if (process.env.HOST_E2E_CHROMIUM) return process.env.HOST_E2E_CHROMIUM;
  return [
    "/opt/pw-browsers/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find(existsSync);
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
    assert.equal(await page.getByRole("link", { name: "Audit log", exact: true }).count(), 0);
    assert.equal(await page.getByRole("link", { name: "Settings", exact: true }).count(), 0);
    const token = await organizerToken({ admin: host.admin.origin, key });
    const adminOrigin = host.admin.origin;
    const request = (path: string, method = "GET", body?: unknown) =>
      fetch(`${adminOrigin}/api${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    assert.equal(
      (await request("/feature-flags", "PUT", { key: "audit", enabled: true })).status,
      200,
    );
    await signInOrganizer(page, { admin: host.admin.origin, key });
    assert.ok(store);
    store.database.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON host_audit_records BEGIN SELECT RAISE(ABORT, 'unavailable'); END;",
    );
    assert.equal(
      (await request("/feature-flags", "PUT", { key: "audit", enabled: false })).status,
      503,
    );
    store.database.exec("DROP TRIGGER fail_audit");
    assert.equal(store.featureFlags().audit, true);
    const records = await request("/admin/audit-log");
    assert.equal(records.status, 200);
    const history = await records.text();
    assert.ok(history.includes("organizer.login"));
    assert.ok(!history.includes(key));
    assert.ok(!history.includes(host.masterKey));
    const exported = await request("/admin/audit-log/export");
    assert.equal(exported.status, 200);
    const csv = await exported.text();
    assert.ok(csv.includes("organizer.login"));
    assert.ok(csv.includes("host-key"));
    assert.ok(!csv.includes(key));
    assert.ok(!csv.includes(host.masterKey));
    assert.equal(
      (await request("/feature-flags", "PUT", { key: "audit", enabled: false })).status,
      200,
    );
    assert.ok((await (await request("/admin/audit-log")).text()).includes("organizer.login"));
    for (const path of ["/audit-log", "/settings"]) {
      await page.goto(`${host.admin.origin}${path}`);
      await fillOrganizerKey(page, key);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByText("Not available in a local competition", { exact: true }).waitFor();
      assert.equal(await page.getByRole("checkbox", { name: "audit", exact: true }).count(), 0);
      assert.equal(
        await page.getByRole("button", { name: "CSV エクスポート", exact: true }).count(),
        0,
      );
    }
    const anonymous = await fetch(`${host.admin.origin}/api/admin/audit-log`);
    assert.equal(anonymous.status, 401);
    const otherSurface = await fetch(`${host.participant.origin}/api/admin/audit-log`);
    assert.equal(otherSurface.status, 404);
    assert.deepEqual(errors, []);
    mkdirSync(artifacts, { recursive: true });
    await page.screenshot({
      path: join(artifacts, "audit-ui-removed.png"),
      fullPage: true,
    });
    console.log(
      "PASS hidden local audit routes with retained key-login history, secret exclusion, fail-closed settings and access boundaries (real HTTP/SQLite).",
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
