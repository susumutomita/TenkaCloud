import { createTemporaryDirectory, removeTemporaryDirectory } from "../temporary-directory";
/** Built console and production HTTP/SQLite wiring, with a test-only exercise engine. */

import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { parseGatewayPorts } from "../gateway-ports";
import { type RunningLocalHost, startLocalHost } from "../server";
import { ExerciseFixture } from "./exercise-fixture";
import { REHEARSAL_ORGANIZER } from "./organizer-login";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const data = createTemporaryDirectory(root, "tenkacloud-organizers-");
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- Test-only users in a temporary SQLite database.
const operatorPassword = "operator rehearsal password 2026";
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- Test-only users in a temporary SQLite database.
const viewerPassword = "viewer rehearsal password 2026";

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

async function tokenFrom(page: Page, action: () => Promise<void>, path: string): Promise<string> {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith(`/api${path}`) && candidate.request().method() === "POST",
  );
  await action();
  const result = await response;
  assert.ok(result.ok(), `${path} returned HTTP ${result.status()}`);
  const body: unknown = await result.json();
  assert.ok(body && typeof body === "object" && "idToken" in body);
  if (typeof body.idToken !== "string") throw new Error(`${path} did not return an id token.`);
  return body.idToken;
}

async function signIn(page: Page, origin: string, username: string, password: string) {
  await page.goto(`${origin}/events`);
  await page.locator("#organizer-username").fill(username);
  await page.locator("#organizer-password").fill(password);
  const token = await tokenFrom(
    page,
    () => page.getByRole("button", { name: "Sign in" }).click(),
    "/host/login",
  );
  await page.getByRole("heading", { name: "Events", exact: true }).waitFor();
  return token;
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

async function addUser(page: Page, name: string, password: string, role: string) {
  await page.getByLabel("Username").fill(name);
  await page.getByLabel("Password (at least 12 characters)").fill(password);
  await page.getByLabel("New user role").selectOption(role);
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith("/api/host/users") && candidate.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add", exact: true }).click();
  assert.equal((await response).status(), 201);
  await page.getByText(name, { exact: true }).waitFor();
}

async function main() {
  let host: RunningLocalHost | undefined;
  let browser: Browser | undefined;
  try {
    host = await start();
    const executablePath = process.env.HOST_E2E_CHROMIUM;
    browser = await chromium.launch({
      ...(executablePath || existsSync("/opt/pw-browsers/chromium")
        ? { executablePath: executablePath || "/opt/pw-browsers/chromium" }
        : {}),
    });
    const adminContext = await browser.newContext({ locale: "en-US" });
    const adminPage = await adminContext.newPage();
    const keyLogin = await fetch(`${host.admin.origin}/api/host/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: host.masterKey }),
    });
    assert.equal(keyLogin.status, 409);
    assert.equal(((await keyLogin.json()) as { kind: string }).kind, "bootstrap_required");
    await adminPage.goto(`${host.admin.origin}/events`);
    await adminPage.locator("#local-host-key").fill(host.masterKey);
    await adminPage.locator("#organizer-username").fill(REHEARSAL_ORGANIZER.username);
    await adminPage.locator("#organizer-password").fill(REHEARSAL_ORGANIZER.password);
    const adminToken = await tokenFrom(
      adminPage,
      () => adminPage.getByRole("button", { name: "Create Admin account" }).click(),
      "/host/bootstrap",
    );
    await adminPage.getByRole("heading", { name: "Events", exact: true }).waitFor();
    const bootstrap = await fetch(`${host.admin.origin}/api/host/bootstrap-status`);
    assert.deepEqual(await bootstrap.json(), { bootstrapCompleted: true });
    assert.equal((await api(host.admin.origin, adminToken, "GET", "/host/me")).status, 200);

    await adminPage.goto(`${host.admin.origin}/events`);
    await adminPage.locator("#local-host-key").waitFor({ state: "detached" });
    await signIn(
      adminPage,
      host.admin.origin,
      REHEARSAL_ORGANIZER.username,
      REHEARSAL_ORGANIZER.password,
    );
    await adminPage.locator('a[href="/users"]').click();
    await adminPage.getByRole("heading", { name: "Organizer users" }).waitFor();
    await addUser(adminPage, "operator", operatorPassword, "Operator");
    await addUser(adminPage, "viewer", viewerPassword, "Viewer");
    await adminPage.locator('a[href="/settings"]').click();
    await adminPage.getByRole("heading", { name: "Local host settings" }).waitFor();
    const enable = adminPage.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/feature-flags") && candidate.request().method() === "PUT",
    );
    await adminPage.getByRole("checkbox", { name: "audit" }).click();
    assert.equal((await enable).status(), 200);
    const enabled = await api(host.admin.origin, adminToken, "GET", "/feature-flags");
    assert.deepEqual(await enabled.json(), {
      flags: {
        saml: false,
        audit: true,
        challengePrerequisiteGate: false,
        registration: false,
      },
    });
    const disable = adminPage.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/feature-flags") && candidate.request().method() === "PUT",
    );
    await adminPage.getByRole("checkbox", { name: "audit" }).click();
    assert.equal((await disable).status(), 200);

    const operatorPage = await (await browser.newContext({ locale: "en-US" })).newPage();
    const operatorToken = await signIn(
      operatorPage,
      host.admin.origin,
      "operator",
      operatorPassword,
    );
    assert.equal(await operatorPage.locator('a[href="/users"]').count(), 0);
    assert.equal(
      await operatorPage.getByRole("button", { name: "Create event" }).first().isEnabled(),
      true,
    );
    assert.equal((await api(host.admin.origin, operatorToken, "GET", "/host/users")).status, 403);
    const viewerPage = await (await browser.newContext({ locale: "en-US" })).newPage();
    const viewerToken = await signIn(viewerPage, host.admin.origin, "viewer", viewerPassword);
    assert.equal(await viewerPage.locator('a[href="/users"]').count(), 0);
    assert.equal(
      await viewerPage.getByRole("button", { name: "Create event" }).first().isEnabled(),
      false,
    );
    assert.equal((await api(host.admin.origin, viewerToken, "POST", "/events", {})).status, 403);

    await host.stop();
    host = await start();
    const afterRestart = await fetch(`${host.admin.origin}/api/host/bootstrap-status`);
    assert.deepEqual(await afterRestart.json(), { bootstrapCompleted: true });
    assert.equal((await api(host.admin.origin, viewerToken, "GET", "/events")).status, 200);
    assert.equal((await api(host.admin.origin, adminToken, "GET", "/host/me")).status, 200);
    const flags = await api(host.admin.origin, adminToken, "GET", "/feature-flags");
    assert.deepEqual(await flags.json(), {
      flags: {
        saml: false,
        audit: false,
        challengePrerequisiteGate: false,
        registration: false,
      },
    });
    const reopened = await browser.newPage({ locale: "en-US" });
    await signIn(
      reopened,
      host.admin.origin,
      REHEARSAL_ORGANIZER.username,
      REHEARSAL_ORGANIZER.password,
    );
    console.log("PASS organizer browser: bootstrap, users, roles, flags, and SQLite restart");
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
