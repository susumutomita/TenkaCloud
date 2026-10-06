/**
 * Real browser + HTTP + SQLite rehearsal for optional cloud account onboarding.
 * Run after `bun run build:host`; the STS and CloudFormation adapters are in-memory fakes.
 * No AWS credential chain or AWS endpoint is used.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { connectCloudHosting } from "../cloud-hosting";
import { CompetitionEngine } from "../competition-engine";
import { parseGatewayPorts } from "../gateway-ports";
import { startLocalHost } from "../server";
import type { HostStore } from "../store";
import { createTemporaryDirectory, removeTemporaryDirectory } from "../temporary-directory";
import { FakeAws } from "./fake-aws";
import { signInOrganizer } from "./organizer-login";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const accountId = "111111111111";
const artifacts = join(root, ".tenkacloud/host-accounts-e2e");

function chromiumPath(): string | undefined {
  if (process.env.HOST_E2E_CHROMIUM) return process.env.HOST_E2E_CHROMIUM;
  return existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined;
}

async function signIn(page: Page, origin: string, hostKey: string): Promise<void> {
  await signInOrganizer(page, { admin: origin, key: hostKey });
  await page.locator('a[href="/competitor-accounts"]').click();
  await page.getByRole("heading", { name: "Competitor Accounts" }).first().waitFor();
}

async function register(
  page: Page,
  operatorAccountId: string,
  externalId: string,
): Promise<string> {
  await page.getByRole("button", { name: "Add account" }).first().click();
  const form = page.getByRole("dialog", { name: "Add Competitor Account" });
  await form.getByLabel("AWS Account ID").fill(accountId);
  const roleName = await form.getByLabel("IAM Role name").inputValue();
  assert.ok(roleName, "The form shows the exact role to bootstrap.");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  const secret = page.getByRole("dialog", { name: "Information to share with the competitor" });
  await secret.getByText("Protect the host ExternalId").waitFor();
  await secret.getByText("Manual deploy details").click();
  assert.equal(await secret.getByText(operatorAccountId, { exact: true }).count(), 1);
  assert.equal(await secret.getByText(externalId, { exact: true }).count(), 1);
  assert.equal(await secret.getByText(roleName, { exact: true }).count(), 1);
  assert.match(
    (await secret.getByRole("link", { name: /competitor-bootstrap.yaml/u }).getAttribute("href")) ??
      "",
    /competitor-bootstrap\.yaml/u,
  );
  assert.equal(await secret.getByRole("button", { name: /Launch Stack/u }).count(), 0);
  await secret.getByRole("button", { name: "Close" }).click();
  return roleName;
}

async function createMixedEvent(page: Page): Promise<string> {
  await page.getByRole("link", { name: "Events" }).click();
  await page.getByRole("button", { name: "Create event" }).first().click();
  await page.getByLabel("Event name").fill("Accounts browser rehearsal");
  await page.getByLabel("Team count").fill("1");
  await page
    .getByTestId("problem-select")
    .getByRole("checkbox", { name: /Hello World \(Sample\)/u })
    .check();
  await page
    .getByTestId("problem-select")
    .getByRole("checkbox", { name: /Cryptography Battle|暗号バトル/u })
    .check();
  await page.getByText("Select a verified account").click();
  await page.getByRole("option", { name: new RegExp(accountId, "u") }).click();
  await page.getByRole("button", { name: "Create Event" }).click();
  const prompt = page.getByRole("dialog");
  await prompt.getByText("Save these login keys now").waitFor();
  await prompt.getByRole("button", { name: "Later" }).click();
  await page.waitForURL(/\/events\/[0-9A-HJKMNP-TV-Z]{26}$/u);
  const eventId = page.url().split("/").at(-1);
  assert.ok(eventId, "The browser navigated to the created event.");
  return eventId;
}

async function rejectAssignedDelete(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Competitor Accounts" }).click();
  const row = page.getByRole("row").filter({ hasText: accountId });
  await row.getByRole("button", { name: "Delete" }).click();
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith(`/api/admin/competitor-accounts/${accountId}`) &&
      candidate.request().method() === "DELETE",
  );
  await page
    .getByRole("dialog", { name: "Delete account" })
    .getByRole("button", { name: "Delete" })
    .click();
  assert.equal((await response).status(), 409);
  await row.getByText("Verified").waitFor();
}

async function main(): Promise<void> {
  const dataDirectory = createTemporaryDirectory(root, "tenkacloud-host-accounts-e2e-");
  const fakeAws = new FakeAws();
  let browser: Browser | undefined;
  let page: Page | undefined;
  let host: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  let store: HostStore | undefined;
  try {
    const cloud = await connectCloudHosting(root, dataDirectory, "ap-northeast-1", {
      sts: fakeAws.sts as never,
      cloudFormation: fakeAws.cloudFormation as never,
    });
    host = await startLocalHost(
      root,
      {
        dataDirectory,
        hostname: "127.0.0.1",
        adminPort: 5484,
        participantPort: 5485,
        gatewayPorts: parseGatewayPorts("5500-5539"),
        accountConnection: cloud,
      },
      (directory, openedStore) => {
        store = openedStore;
        return new CompetitionEngine(
          root,
          directory,
          true,
          cloud.engine((job) => openedStore.team(job.teamId)),
        );
      },
    );
    browser = await chromium.launch({ executablePath: chromiumPath() });
    const context = await browser.newContext({ locale: "en-US" });
    context.setDefaultTimeout(90_000);
    page = await context.newPage();
    assert.ok(host.organizerKey, "The fresh host provides its organizer key.");
    await signIn(page, host.admin.origin, host.organizerKey);
    const roleName = await register(page, cloud.operatorAccountId, cloud.externalId);
    const row = page.getByRole("row").filter({ hasText: accountId });
    await row.getByRole("button", { name: "Verify" }).click();
    await row.getByText("Verified").waitFor();
    assert.ok(
      fakeAws.assumed.some(
        (input) =>
          input.RoleArn === `arn:aws:iam::${accountId}:role/${roleName}` &&
          input.ExternalId === cloud.externalId,
      ),
      "Verification used the registered role and mandatory ExternalId.",
    );
    const eventId = await createMixedEvent(page);
    assert.equal(store?.teams(eventId)[0]?.aws?.roleName, roleName);
    assert.deepEqual(
      store
        ?.event(eventId)
        .problems.map((problem) => problem.runtime)
        .sort((left, right) => String(left).localeCompare(String(right))),
      ["cloudformation", "coordination"],
    );
    await rejectAssignedDelete(page);
    console.log("PASS account browser rehearsal (real HTTP/SQLite, fake STS; no AWS calls)");
  } catch (error) {
    if (page) {
      mkdirSync(artifacts, { recursive: true });
      await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true });
    }
    throw error;
  } finally {
    await browser?.close();
    await host?.stop();
    removeTemporaryDirectory(root, dataDirectory);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
