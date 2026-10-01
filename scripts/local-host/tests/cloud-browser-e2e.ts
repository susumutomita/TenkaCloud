import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright-core";
import { connectCloudHosting } from "../cloud-hosting";
import { CompetitionEngine } from "../competition-engine";
import { parseGatewayPorts } from "../gateway-ports";
import { startLocalHost } from "../server";
import { FakeAws, fakeFlag } from "./fake-aws";
import { REHEARSAL_ORGANIZER } from "./organizer-login";

interface CreatedEvent {
  eventId: string;
  teams: { teamId: string; internalSlug: string; teamLoginKey: string }[];
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const data = mkdtempSync(join(tmpdir(), "tenkacloud-cloud-browser-"));
  try {
    await rehearse(root, data);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
}

async function rehearse(root: string, data: string): Promise<void> {
  const aws = new FakeAws();
  const cloud = await connectCloudHosting(root, data, "ap-northeast-1", {
    sts: aws.sts as never,
    cloudFormation: aws.cloudFormation as never,
  });
  const host = await startLocalHost(
    root,
    {
      dataDirectory: data,
      accountConnection: cloud,
      hostname: "127.0.0.1",
      adminPort: 0,
      participantPort: 0,
      gatewayPorts: parseGatewayPorts("24400-24439"),
    },
    (directory, store) =>
      new CompetitionEngine(
        root,
        directory,
        false,
        cloud.engine((job) => store.team(job.teamId)),
      ),
  );
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      executablePath:
        process.env.HOST_E2E_CHROMIUM ??
        (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined),
    });
    const login = await fetch(`${host.admin.origin}/api/host/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: host.masterKey, ...REHEARSAL_ORGANIZER }),
    });
    assert.equal(login.status, 201);
    const { idToken } = (await login.json()) as { idToken: string };
    async function admin(method: string, path: string, body: unknown = {}) {
      const response = await fetch(`${host.admin.origin}/api${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
        body: method === "GET" ? undefined : JSON.stringify(body),
      });
      assert.ok(
        response.ok,
        `${method} ${path}: ${response.status} ${await response.clone().text()}`,
      );
      return response;
    }
    for (const awsAccountId of ["111111111111", "222222222222"]) {
      await admin("POST", "/admin/competitor-accounts", { awsAccountId });
      await admin("POST", `/admin/competitor-accounts/${awsAccountId}/verify`);
    }
    const created = await admin("POST", "/events", {
      name: "Cloud browser rehearsal",
      teams: [
        { internalSlug: "alpha", awsAccountId: "111111111111" },
        { internalSlug: "beta", awsAccountId: "222222222222" },
      ],
      problems: [{ problemId: "hello-world" }],
    });
    const event = (await created.json()) as CreatedEvent;
    await admin("POST", `/events/${event.eventId}/deploy`);
    await waitForJobs("COMPLETE");
    async function waitForJobs(status: "COMPLETE" | "DELETED"): Promise<void> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const response = await admin("GET", `/events/${event.eventId}`);
        const detail = (await response.json()) as {
          deploymentsByProblem: Record<string, { status: string }[]>;
        };
        const jobs = Object.values(detail.deploymentsByProblem).flat();
        assert.equal(jobs.length, 2);
        assert.ok(
          jobs.every((job) => job.status !== "FAILED"),
          "Cloud operation failed.",
        );
        if (jobs.every((job) => job.status === status)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`The cloud jobs did not reach ${status}.`);
    }
    await admin("PATCH", `/events/${event.eventId}/schedule`, { startNow: true });
    const pageErrors: string[] = [];
    for (const team of event.teams) {
      const context = await browser.newContext({ locale: "en-US" });
      const page = await context.newPage();
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(`${host.participant.origin}/login#invite=${team.teamLoginKey}`);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL((url) => !url.pathname.startsWith("/login"));
      await page.goto(`${host.participant.origin}/problems`);
      await page.getByText("Hello World (Sample)", { exact: true }).first().click();
      const stack = aws.created.find((input) => input.StackName?.includes(team.internalSlug));
      assert.ok(stack?.StackName, "A separate stack was created for the team.");
      const flag = fakeFlag(stack.StackName);
      assert.ok(!(await page.locator("body").innerText()).includes(flag));
      await page.getByLabel(/Flag/u).first().fill(flag);
      await page
        .getByRole("button", { name: /Submit flag/u })
        .first()
        .click();
      await page
        .getByText(/Correct!/u)
        .first()
        .waitFor();
      await page.goto(`${host.participant.origin}/scoreboard`);
      await page.getByRole("row").filter({ hasText: "(you)" }).getByText("100 pt").waitFor();
      await context.close();
    }
    assert.deepEqual(pageErrors, []);
    await admin("POST", `/events/${event.eventId}/end`);
    await admin("DELETE", `/events/${event.eventId}`);
    await waitForJobs("DELETED");
    assert.equal(aws.deleted.length, 2);
    assert.ok(aws.stacks.every((stack) => stack.status === "DELETE_COMPLETE"));
    console.log(
      "PASS cloud participant browser rehearsal (test-only AWS adapter, no real AWS calls)",
    );
  } finally {
    await browser?.close();
    await host.stop();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
