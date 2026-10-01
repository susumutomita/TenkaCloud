/** Built-SPA rehearsal of hello-world-battle. Fake AWS and an injected probe never reach AWS. */

import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { type Browser, chromium, type Page } from "playwright-core";
import { apiRequest, HOST_KEY } from "../bench/state-setup";
import { hostBuildDirectory } from "../build";
import { CloudFormationEngine } from "../cloudformation-engine";
import { CompetitionEngine } from "../competition-engine";
import { type HttpHost, startHttpHost } from "../http";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { FakeAws } from "./fake-aws";
import { bootstrapOrganizer } from "./organizer-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = join(root, ".tenkacloud/uptime-browser-e2e");

async function main(): Promise<void> {
  const built = hostBuildDirectory(root, "participant-portal");
  if (!existsSync(join(built, "host.html"))) throw new Error("Run bun run build:host first.");
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(tmpdir(), "tenka-uptime-browser-"));
  const store = new HostStore(new Database(join(directory, "host.sqlite")));
  let listener: HttpHost | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  try {
    const aws = new FakeAws();
    const cloud = new CloudFormationEngine(root, {
      region: "ap-northeast-1",
      externalId: "host-external-id-0123456789",
      operatorAccountId: async () => "999999999999",
      sts: aws.sts as never,
      cloudFormation: aws.cloudFormation as never,
      team: (job) => store.team(job.teamId),
      sleep: async () => undefined,
      pollIntervalMs: 0,
      timeoutMs: 60_000,
    });
    const service = new HostingService(
      store,
      new CompetitionEngine(root, directory, false, cloud),
      HOST_KEY,
      Date.now,
      console.error,
      async () => ({ ok: true, status: 200, responseTimeMs: 1 }),
    );
    service.accountConnection = {
      region: "ap-northeast-1",
      operatorAccountId: "999999999999",
      externalId: "host-external-id-0123456789",
      verify: async (accountId, roleName) => {
        await aws.sts.send(
          new AssumeRoleCommand({
            RoleArn: `arn:aws:iam::${accountId}:role/${roleName}`,
            ExternalId: "host-external-id-0123456789",
            RoleSessionName: "uptime-browser-verify",
          }),
        );
      },
    };
    const adminToken = await bootstrapOrganizer(service, HOST_KEY);
    const admin = (method: string, path: string, body: Record<string, unknown> = {}) =>
      service.admin(apiRequest({ method, path, token: adminToken, body }));
    assert.equal(
      (await admin("POST", "/admin/competitor-accounts", { awsAccountId: "111111111111" })).status,
      201,
    );
    assert.equal(
      (await admin("POST", "/admin/competitor-accounts/111111111111/verify")).status,
      200,
    );
    const created = await admin("POST", "/events", {
      name: "Uptime browser rehearsal",
      teams: [{ internalSlug: "alpha", awsAccountId: "111111111111" }],
      problems: [{ problemId: "hello-world-battle" }],
    });
    assert.equal(created.status, 201);
    const event = created.body as {
      eventId: string;
      teams: { teamId: string; teamLoginKey: string }[];
    };
    const team = event.teams[0];
    assert.ok(team);
    assert.equal((await admin("POST", `/events/${event.eventId}/deploy`)).status, 202);
    await service.drain();
    assert.equal(store.event(event.eventId).status, "READY");
    assert.equal(
      (await admin("PATCH", `/events/${event.eventId}/schedule`, { startNow: true })).status,
      200,
    );
    listener = await startHttpHost({
      kind: "participant",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot: built,
      service,
    });
    browser = await chromium.launch({ executablePath: process.env.HOST_E2E_CHROMIUM });
    const context = await browser.newContext({ locale: "en-US" });
    context.setDefaultTimeout(30_000);
    page = await context.newPage();
    await page.goto(`${listener.origin}/login#invite=${encodeURIComponent(team.teamLoginKey)}`);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"));
    await page.goto(`${listener.origin}/problems`);
    await page.getByText("Hello World Battle (Sample)").first().click();
    await page.getByRole("heading", { name: "Endpoint registration" }).waitFor();
    const inputs = page.getByRole("textbox", { name: "Register new URL" });
    const register = page.getByRole("button", { name: "Register", exact: true });
    await inputs.nth(0).fill("https://frontend.example.com");
    await register.nth(0).click();
    await page.getByText("https://frontend.example.com").first().waitFor();
    await service.uptime.tick();
    assert.equal(store.team(team.teamId).score, 0, "one registered slot must not score");
    await inputs.nth(1).fill("https://api.example.com");
    await register.nth(1).click();
    await page.getByText("https://api.example.com").first().waitFor();
    await service.uptime.tick();
    assert.equal(store.team(team.teamId).score, 100);
    await page
      .getByRole("link", { name: /Scoreboard/u })
      .first()
      .click();
    await page.getByRole("cell", { name: "100 pt", exact: true }).waitFor();
    console.log(
      "PASS hello-world-battle participant browser registration and SQLite scoring (Fake AWS, injected probe)",
    );
  } catch (error) {
    await page?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true });
    throw error;
  } finally {
    await browser?.close();
    await listener?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
