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
import {
  legacyAuditSnapshot,
  rejectLegacyAuditWrites,
  seedLegacyAudit,
} from "./audit-retirement-fixture";
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
  let seeded = false;
  const start = () =>
    startLocalHost(
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
        if (!seeded) {
          seedLegacyAudit(store);
          rejectLegacyAuditWrites(store);
          seeded = true;
        }
        return new ExerciseFixture((path) => new Database(path));
      },
      () => undefined,
    );
  try {
    host = await start();
    assert.ok(store);
    const legacy = legacyAuditSnapshot(store);
    const key = host.organizerKey;
    assert.ok(key, "The fresh host provides its organizer key.");
    browser = await chromium.launch({ executablePath: chromiumPath() });
    const context = await browser.newContext({ locale: "en-US" });
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
    for (const enabled of [true, false])
      assert.equal((await request("/feature-flags", "PUT", { key: "audit", enabled })).status, 400);
    await signInOrganizer(page, { admin: host.admin.origin, key });
    assert.equal(store.featureFlags().audit, false);
    for (const path of ["/admin/audit-log", "/admin/audit-log/export"])
      assert.equal((await request(path)).status, 404);
    const created = await request("/events", "POST", {
      name: "Audit retirement",
      teams: [{ internalSlug: "one" }],
      problems: [{ problemId: "sqli-demo" }],
    });
    assert.equal(created.status, 201);
    const { eventId } = (await created.json()) as { eventId: string };
    assert.deepEqual(legacyAuditSnapshot(store), legacy);
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
    await host.stop();
    host = await start();
    await signInOrganizer(page, { admin: host.admin.origin, key });
    assert.equal(store.event(eventId).name, "Audit retirement");
    assert.deepEqual(legacyAuditSnapshot(store), legacy);
    console.log(
      "PASS retired local audit UI/API/collection with unchanged legacy history, ordinary event creation, key login and restart (real HTTP/SQLite).",
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
