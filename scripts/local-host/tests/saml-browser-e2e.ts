import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { parseGatewayPorts } from "../gateway-ports";
import { closeServer, listen } from "../http";
import { startLocalHost } from "../server";
import { createTemporaryDirectory, removeTemporaryDirectory } from "../temporary-directory";
import { ExerciseFixture } from "./exercise-fixture";
import { TestSamlIdP } from "./saml-idp-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = join(root, ".tenkacloud/host-saml-e2e");
function chromiumPath(): string | undefined {
  if (process.env.HOST_E2E_CHROMIUM) return process.env.HOST_E2E_CHROMIUM;
  for (const path of [
    "/opt/pw-browsers/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ])
    if (existsSync(path)) return path;
  return undefined;
}
async function mutate(
  page: Page,
  method: string,
  endpoint: string,
  action: () => Promise<unknown>,
) {
  const result = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api${endpoint}` &&
      response.request().method() === method,
  );
  await action();
  const response = await result;
  assert.ok(response.ok(), `${method} ${endpoint} succeeds.`);
}
async function configure(
  page: Page,
  host: Awaited<ReturnType<typeof startLocalHost>>,
  provider: TestSamlIdP,
  idpOrigin: string,
) {
  await page.goto(`${host.admin.origin}/login`);
  await page.locator("#local-host-key").fill(host.masterKey);
  await page.locator("#organizer-username").fill("local-admin");
  await page.locator("#organizer-password").fill("test-only-long-admin-password");
  await page.getByRole("button", { name: "Create Admin account", exact: true }).click();
  await page.getByRole("link", { name: "Users", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill("viewer");
  await page
    .getByLabel("Password (at least 12 characters)", { exact: true })
    .fill("test-only-viewer-password");
  await page.getByLabel("New user role", { exact: true }).selectOption("Viewer");
  await mutate(page, "POST", "/host/users", () =>
    page.getByRole("button", { name: "Add", exact: true }).click(),
  );
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("IdP Entity ID", { exact: true }).fill(provider.issuer);
  await page
    .getByLabel("IdP sign-in URL (HTTP-Redirect)", { exact: true })
    .fill(`${idpOrigin}/login`);
  await page
    .getByLabel("IdP signing certificate (PEM)", { exact: true })
    .fill(provider.certificate);
  await mutate(page, "PUT", "/host/saml/provider", () =>
    page.getByRole("button", { name: "Save IdP settings" }).click(),
  );
  assert.equal(
    await page.getByLabel("SP Entity ID (register with IdP)", { exact: true }).inputValue(),
    `${host.admin.origin}/api/host/saml/metadata`,
  );
  assert.equal(
    await page.getByLabel("ACS URL (HTTP-POST)", { exact: true }).inputValue(),
    `${host.admin.origin}/api/host/saml/acs`,
  );
  await page
    .getByLabel("Existing organizer", { exact: true })
    .selectOption({ label: "viewer (Viewer)" });
  await page.getByLabel("Persistent NameID", { exact: true }).fill("stable-subject-123");
  await mutate(page, "POST", "/host/saml/identities", () =>
    page.getByRole("button", { name: "Link NameID" }).click(),
  );
  await mutate(page, "PUT", "/feature-flags", () =>
    page.getByRole("checkbox", { name: "saml", exact: true }).click(),
  );
  await page.getByRole("checkbox", { name: "saml", exact: true, checked: true }).waitFor();
}
async function main() {
  const data = createTemporaryDirectory(root, "tenka-saml-browser-");
  let provider: TestSamlIdP | undefined;
  let browser: Browser | undefined;
  let adminPage: Page | undefined;
  let viewerPage: Page | undefined;
  let host: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  let idpServer: ReturnType<typeof createServer> | undefined;
  const errors: string[] = [];
  try {
    provider = new TestSamlIdP();
    const idp = provider;
    idpServer = createServer((request, response) => {
      try {
        const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
        if (request.method !== "GET" || url.pathname !== "/login") {
          response.writeHead(404);
          response.end();
          return;
        }
        const parsed = idp.request(url.href);
        const signed = idp.response(parsed);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(
          `<!doctype html><html lang="en"><body><h1>Test identity provider</h1><form method="post" action="${parsed.callback}"><input type="hidden" name="SAMLResponse" value="${signed}"><input type="hidden" name="RelayState" value="${parsed.relay}"><button>Continue as viewer</button></form></body></html>`,
        );
      } catch {
        response.writeHead(400);
        response.end("Invalid test authentication request.");
      }
    });
    const idpOrigin = (await listen(idpServer, "127.0.0.1", 0)).replace("127.0.0.1", "localhost");
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
    browser = await chromium.launch({ executablePath: chromiumPath() });
    const adminContext = await browser.newContext({ locale: "en-US" });
    adminPage = await adminContext.newPage();
    adminPage.on("pageerror", (error) => errors.push(error.message));
    await configure(adminPage, host, provider, idpOrigin);
    const viewerContext = await browser.newContext({ locale: "en-US" });
    viewerPage = await viewerContext.newPage();
    viewerPage.on("pageerror", (error) => errors.push(error.message));
    let acsOrigin: string | undefined;
    viewerPage.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/host/saml/acs")
        acsOrigin = request.headers().origin;
    });
    await viewerPage.goto(`${host.admin.origin}/login`);
    await viewerPage.getByRole("button", { name: "Sign in with SAML", exact: true }).click();
    await viewerPage.getByRole("heading", { name: "Test identity provider" }).waitFor();
    const completeResponse = viewerPage.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/host/saml/complete",
    );
    await viewerPage.getByRole("button", { name: "Continue as viewer" }).click();
    const complete = await completeResponse;
    assert.equal(complete.status(), 200);
    const tokens = (await complete.json()) as { idToken: string };
    await viewerPage.waitForURL(`${host.admin.origin}/events`);
    await viewerPage.getByRole("button", { name: "Menu for viewer" }).waitFor();
    assert.equal(
      acsOrigin,
      idpOrigin,
      "The browser posted the signed response from the separate IdP site.",
    );
    assert.equal(
      await viewerPage.evaluate(() => sessionStorage.getItem("tenkacloud.saml.browser-proof")),
      null,
    );
    assert.equal(new URL(viewerPage.url()).hash, "");
    assert.equal(await viewerPage.getByRole("link", { name: "Users", exact: true }).count(), 0);
    const denied = await fetch(`${host.admin.origin}/api/host/saml/provider`, {
      headers: { authorization: `Bearer ${tokens.idToken}` },
    });
    assert.equal(denied.status, 403);
    const samlToggle = adminPage.getByRole("checkbox", { name: "saml", exact: true });
    await mutate(adminPage, "PUT", "/feature-flags", () => samlToggle.click());
    await adminPage.getByRole("checkbox", { name: "saml", exact: true, checked: false }).waitFor();
    const revoked = await fetch(`${host.admin.origin}/api/host/me`, {
      headers: { authorization: `Bearer ${tokens.idToken}` },
    });
    assert.equal(revoked.status, 401);
    await viewerPage.reload();
    await viewerPage.locator("#organizer-username").waitFor();
    assert.equal(
      await viewerPage.getByRole("button", { name: "Sign in with SAML", exact: true }).count(),
      0,
    );
    assert.deepEqual(errors, []);
    mkdirSync(artifacts, { recursive: true });
    await adminPage.screenshot({ path: join(artifacts, "saml-settings.png"), fullPage: true });
    console.log(
      "PASS real browser SAML configuration, explicit identity link, cross-site signed login, Viewer permissions and revocation (test IdP only).",
    );
  } catch (error) {
    mkdirSync(artifacts, { recursive: true });
    await (viewerPage ?? adminPage)?.screenshot({
      path: join(artifacts, "failure.png"),
      fullPage: true,
    });
    throw error;
  } finally {
    await browser?.close();
    await host?.stop();
    if (idpServer?.listening) await closeServer(idpServer);
    provider?.close();
    removeTemporaryDirectory(root, data);
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
