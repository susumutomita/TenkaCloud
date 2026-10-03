/** Local key mode must not expose the legacy account/SAML flows. */
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { parseGatewayPorts } from "../gateway-ports";
import { startLocalHost } from "../server";
import { createTemporaryDirectory, removeTemporaryDirectory } from "../temporary-directory";
import { ExerciseFixture } from "./exercise-fixture";
import { organizerToken, signInOrganizer } from "./organizer-login";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = join(root, ".tenkacloud/host-saml-e2e");
function chromiumPath(): string | undefined {
  if (process.env.HOST_E2E_CHROMIUM) return process.env.HOST_E2E_CHROMIUM;
  return [
    "/opt/pw-browsers/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find(existsSync);
}
async function main() {
  const data = createTemporaryDirectory(root, "tenka-saml-browser-");
  let browser: Browser | undefined;
  let page: Page | undefined;
  let host: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  const errors: string[] = [];
  try {
    host = await startLocalHost(
      root,
      {
        dataDirectory: data,
        hostname: "127.0.0.1",
        adminPort: 0,
        participantPort: 0,
        gatewayPorts: parseGatewayPorts("5610-5649"),
      },
      () => new ExerciseFixture((path) => new Database(path)),
      () => undefined,
    );
    const key = host.organizerKey;
    assert.ok(key, "The fresh host provides its organizer key.");
    browser = await chromium.launch({ executablePath: chromiumPath() });
    page = await browser.newPage({ locale: "en-US" });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${host.admin.origin}/login`);
    await page.getByLabel("Organizer key", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Sign in with SAML", exact: true }).count(),
      0,
    );
    assert.equal(await page.locator("#organizer-username, #organizer-password").count(), 0);
    await signInOrganizer(page, { admin: host.admin.origin, key });
    assert.equal(await page.getByRole("link", { name: "Settings", exact: true }).count(), 0);
    assert.equal(await page.getByRole("link", { name: "Audit log", exact: true }).count(), 0);
    assert.equal(await page.getByRole("checkbox", { name: "audit", exact: true }).count(), 0);
    assert.equal(await page.getByRole("checkbox", { name: "saml", exact: true }).count(), 0);
    assert.equal(await page.getByLabel("IdP Entity ID", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("link", { name: "Users", exact: true }).count(), 0);

    const idToken = await organizerToken({ admin: host.admin.origin, key });
    for (const [method, path] of [
      ["GET", "/host/saml/metadata"],
      ["GET", "/host/saml/provider"],
      ["PUT", "/host/saml/provider"],
      ["POST", "/host/saml/start"],
      ["POST", "/host/saml/complete"],
      ["POST", "/host/saml/acs"],
      ["POST", "/host/saml/identities"],
      ["GET", "/host/users"],
      ["POST", "/host/users"],
      ["POST", "/host/bootstrap"],
    ] as const) {
      const response: Response = await fetch(`${host.admin.origin}/api${path}`, {
        method,
        headers: { authorization: `Bearer ${idToken}`, "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: "{}" }),
      });
      assert.equal(response.status, 404, `Local key mode rejects ${method} ${path}.`);
    }
    const saml = await fetch(`${host.admin.origin}/api/host/saml`);
    assert.deepEqual(await saml.json(), { enabled: false });
    const enabled = await fetch(`${host.admin.origin}/api/feature-flags`, {
      method: "PUT",
      headers: { authorization: `Bearer ${idToken}`, "content-type": "application/json" },
      body: JSON.stringify({ key: "saml", enabled: true }),
    });
    assert.equal(enabled.status, 404);
    assert.deepEqual(errors, []);
    mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, "local-key-navigation.png"), fullPage: true });
    console.log(
      "PASS local key mode: no SAML/account controls or legacy API access (real HTTP/SQLite).",
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
