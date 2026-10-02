/** Built console and production HTTP/SQLite wiring, with a test-only exercise engine. */
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { parseGatewayPorts } from "../gateway-ports";
import { type RunningLocalHost, startLocalHost } from "../server";
import { createTemporaryDirectory, removeTemporaryDirectory } from "../temporary-directory";
import { ExerciseFixture } from "./exercise-fixture";
import { fillOrganizerKey } from "./organizer-login";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const data = createTemporaryDirectory(root, "tenkacloud-organizers-");

async function start(): Promise<RunningLocalHost> {
  const fixture = new ExerciseFixture((path) => new Database(path, { strict: true }));
  return startLocalHost(
    root,
    {
      dataDirectory: data,
      hostname: "127.0.0.1",
      adminPort: 0,
      participantPort: 0,
      gatewayPorts: parseGatewayPorts("5700-5739"),
    },
    () => fixture,
    () => undefined,
  );
}

async function signIn(page: Page, origin: string, key: string) {
  await page.goto(`${origin}/events`);
  const keyInput = page.getByLabel("Organizer key", { exact: true });
  await keyInput.waitFor();
  assert.equal(await keyInput.getAttribute("id"), "local-host-key");
  assert.equal(await keyInput.getAttribute("type"), "password");
  assert.equal(await page.locator("#organizer-username, #organizer-password").count(), 0);
  assert.equal(await page.getByRole("button", { name: /Create Admin account|SAML/u }).count(), 0);
  await fillOrganizerKey(page, key);
  const pending = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/host/login") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), 200);
  const submitted = response.request().postDataJSON() as Record<string, unknown>;
  assert.deepEqual(Object.keys(submitted), ["key"]);
  assert.ok(submitted.key === key, "Only the organizer key is submitted.");
  const tokens = (await response.json()) as { idToken: string; refreshToken: string };
  assert.equal(typeof tokens.idToken, "string");
  assert.equal(typeof tokens.refreshToken, "string");
  await page.getByRole("heading", { name: "Events", exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Users", exact: true }).count(), 0);
  return tokens;
}

async function api(origin: string, token: string, method: string, path: string, body?: unknown) {
  return fetch(`${origin}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function main() {
  let host: RunningLocalHost | undefined;
  let browser: Browser | undefined;
  try {
    host = await start();
    const key = host.organizerKey;
    assert.ok(key, "A fresh host returns its organizer key once.");
    assert.ok(key !== host.masterKey, "The signing secret is separate from the login key.");
    const executablePath = process.env.HOST_E2E_CHROMIUM;
    browser = await chromium.launch({
      ...(executablePath || existsSync("/opt/pw-browsers/chromium")
        ? { executablePath: executablePath || "/opt/pw-browsers/chromium" }
        : {}),
    });
    const page = await browser.newPage({ locale: "en-US" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const original = await signIn(page, host.admin.origin, key);
    assert.equal((await api(host.admin.origin, original.idToken, "GET", "/host/me")).status, 200);
    // Reloading loses the memory-only session, and the same key signs in again.
    await signIn(page, host.admin.origin, key);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("heading", { name: "Local host settings", exact: true }).waitFor();
    await page.getByRole("checkbox", { name: "audit", exact: true }).waitFor();
    assert.equal(await page.getByRole("checkbox").count(), 1);
    const changed = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/feature-flags") && response.request().method() === "PUT",
    );
    await page.getByRole("checkbox", { name: "audit", exact: true }).check();
    assert.equal((await changed).status(), 200);

    for (const body of [
      { key: host.masterKey },
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- Rejected legacy credentials in a disposable host.
      { username: "legacy-admin", password: "legacy-test-only-password" },
      { key, username: "legacy-admin" },
    ]) {
      const rejected = await api(host.admin.origin, "", "POST", "/host/login", body);
      assert.equal(rejected.status, 401);
    }
    assert.equal(
      (await api(host.admin.origin, "", "POST", "/host/bootstrap", { key })).status,
      404,
    );
    assert.equal(
      (await api(host.admin.origin, original.idToken, "GET", "/host/users")).status,
      404,
    );

    await host.stop();
    host = await start();
    assert.equal(host.organizerKey, undefined, "Restart never re-discloses the organizer key.");
    assert.equal((await api(host.admin.origin, original.idToken, "GET", "/events")).status, 200);
    const flags = await api(host.admin.origin, original.idToken, "GET", "/feature-flags");
    assert.equal(((await flags.json()) as { flags: { audit: boolean } }).flags.audit, true);
    const beforeReset = await signIn(page, host.admin.origin, key);

    const replacement = host.rotateOrganizerKey();
    assert.ok(replacement !== key, "Reset produces a new organizer key.");
    assert.equal((await api(host.admin.origin, original.idToken, "GET", "/events")).status, 401);
    assert.equal((await api(host.admin.origin, beforeReset.idToken, "GET", "/events")).status, 401);
    assert.equal((await api(host.admin.origin, "", "POST", "/host/login", { key })).status, 401);
    await signIn(page, host.admin.origin, replacement);
    assert.deepEqual(errors, []);
    console.log(
      "PASS organizer browser: key-only login, hidden legacy controls, audit settings, restart and reset session invalidation",
    );
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
