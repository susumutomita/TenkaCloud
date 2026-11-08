import { strict as assert } from "node:assert";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Browser, chromium } from "playwright-core";
import { z } from "zod";
import { assertHostCatalogBuild } from "../build";
import { CompetitionEngine } from "../competition-engine";
import { startManagedSimulator } from "../managed-simulator";
import { type RunningLocalHost, startLocalHost } from "../server";
import { connectSimulatorHosting } from "../simulator-hosting";

/** Isolated real-browser acceptance. No user state, answers or credentials are logged. */
export async function runSimulatorConsole(options: { binary: string; chromium: string }) {
  const root = resolve(import.meta.dirname, "../../..");
  assertHostCatalogBuild(root);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "tenka-console-gui-")));
  let simulator: Awaited<ReturnType<typeof startManagedSimulator>> | undefined;
  let host: RunningLocalHost | undefined;
  let browser: Browser | undefined;
  let stage = "native startup";
  const checks: string[] = [];
  try {
    simulator = await startManagedSimulator({ binary: options.binary, dataDirectory: directory });
    const connection = await connectSimulatorHosting(
      root,
      join(directory, "host"),
      simulator.settings,
    );
    assert(connection, "Native connection missing.");
    host = await startLocalHost(
      root,
      {
        dataDirectory: join(directory, "host"),
        hostname: "127.0.0.1",
        adminPort: 0,
        participantPort: 0,
        gatewayPorts: { start: 5200, end: 5239 },
        accountConnection: connection,
      },
      (data, store) =>
        new CompetitionEngine(
          root,
          data,
          false,
          connection.engine((job) => store.team(job.teamId)),
        ),
      () => undefined,
    );
    const localHost = host;
    async function api(
      origin: string,
      path: string,
      token: string,
      method = "GET",
      body?: unknown,
    ): Promise<unknown> {
      const response = await fetch(`${origin}/api${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
      assert(response.ok, `Fixture operation failed (${response.status}).`);
      return response.json();
    }
    stage = "organizer setup and original Hello World deployment";
    const auth = z
      .object({ idToken: z.string() })
      .parse(await api(host.admin.origin, "/host/login", "", "POST", { key: host.organizerKey }));
    const admin = (path: string, method = "GET", body?: unknown) =>
      api(localHost.admin.origin, path, auth.idToken, method, body);
    await admin("/admin/competitor-accounts", "POST", {
      awsAccountId: "000000000000",
      competitorRoleName: "TenkaCloud-SimulatorDeploy-Role",
    });
    await admin("/admin/competitor-accounts/000000000000/verify", "POST");
    const event = z
      .object({
        eventId: z.string(),
        teams: z.array(z.object({ teamLoginKey: z.string() })).min(1),
      })
      .parse(
        await admin("/events", "POST", {
          name: "Simulator Console GUI acceptance",
          teams: [{ internalSlug: "gui-alpha", awsAccountId: "000000000000" }],
          problems: [{ problemId: "hello-world" }],
        }),
      );
    const teamKey = event.teams[0]?.teamLoginKey;
    assert(teamKey);
    await admin(`/events/${event.eventId}/deploy`, "POST", {});
    let deployed = false;
    for (let attempt = 0; attempt < 180; attempt++) {
      const detail = z
        .object({
          deploymentsByProblem: z.record(z.string(), z.array(z.object({ status: z.string() }))),
        })
        .parse(await admin(`/events/${event.eventId}`));
      const job = detail.deploymentsByProblem["hello-world"]?.[0];
      assert(job?.status !== "FAILED", "Fixture deployment failed.");
      if (job?.status === "COMPLETE") {
        deployed = true;
        break;
      }
      await Bun.sleep(500);
    }
    assert(deployed, "Fixture deployment timed out.");
    await admin(`/events/${event.eventId}/schedule`, "PATCH", { startNow: true });
    checks.push("native original Hello World deployed");
    stage = "Chromium startup";
    browser = await chromium.launch({
      executablePath: options.chromium,
      headless: true,
      chromiumSandbox: true,
    });
    const context = await browser.newContext({
      locale: "en-US",
      viewport: { width: 1440, height: 1000 },
    });
    const external: string[] = [];
    await context.route("**/*", async (route) => {
      const target = new URL(route.request().url());
      if (target.hostname !== "127.0.0.1" && target.hostname !== "localhost") {
        external.push(target.origin);
        await route.abort();
      } else await route.continue();
    });
    const page = await context.newPage();
    stage = "participant browser login";
    await page.goto(`${host.participant.origin}/login`);
    await page.locator('input[type="password"]').fill(teamKey);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.endsWith("/login"));
    checks.push("participant authenticated through GUI");
    stage = "participant Console button and one-time sign-in";
    await page.goto(`${host.participant.origin}/tools/sso`);
    const popup = context.waitForEvent("page");
    await page
      .getByRole("button", { name: /Open Simulator Console|Simulator Console を開く/ })
      .last()
      .click();
    const consolePage = await popup;
    await consolePage.waitForURL((url) => url.pathname === "/_simulator/console/", {
      timeout: 15_000,
    });
    await consolePage.waitForFunction(() => !location.hash.includes("handoff="));
    checks.push("one-time participant handoff redeemed without operator token");
    stage = "GUI SSM parameter value";
    const parameterValue = consolePage.getByLabel("Value", { exact: true });
    await parameterValue.waitFor({ state: "visible", timeout: 15_000 });
    const value = await parameterValue.inputValue();
    assert(/^TC\{[^}]+\}$/u.test(value), "No parameter value rendered in GUI.");
    checks.push("own SSM parameter read in Simulator GUI");
    const consoleUrl = new URL(consolePage.url());
    const parameterName = new URLSearchParams(consoleUrl.hash.split("?")[1] ?? "").get("parameter");
    assert(parameterName, "Console destination must identify the own parameter.");
    stage = "Console reload session persistence";
    await consolePage.reload();
    await parameterValue.waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await parameterValue.inputValue(), value);
    checks.push("participant Console session survives reload");
    stage = "SSM parameter list and detail navigation";
    await consolePage.goto(`${consoleUrl.origin}/_simulator/console/#/ssm`);
    await consolePage.getByRole("link", { name: parameterName, exact: true }).click();
    await parameterValue.waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await parameterValue.inputValue(), value);
    checks.push("own SSM parameter opened from list through GUI");
    stage = "GUI answer submission";
    await page.goto(`${host.participant.origin}/problems`);
    await page.getByRole("link", { name: /Hello World/u }).click();
    await page.getByPlaceholder(/Enter value|値を入力/u).fill(value);
    const scored = page.waitForResponse((response) =>
      response.url().includes("/portal/me/submit-flag"),
    );
    await page.getByRole("button", { name: /Submit flag|Flag 提出/u }).click();
    const score = z
      .object({ kind: z.literal("ok"), totalScore: z.literal(100) })
      .parse(await (await scored).json());
    assert.equal(score.totalScore, 100);
    checks.push("GUI-submitted answer scored 100");
    stage = "GUI score success message";
    await page
      .getByText(
        /Congratulations\. Your total score is 100 pt\.|おめでとうございます。 合計スコアは 100 pt です。/u,
      )
      .waitFor({ state: "visible", timeout: 15_000 });
    checks.push("100-point success message visible in participant GUI");
    assert.equal(external.length, 0, "Browser attempted a nonlocal request.");
    checks.push("no external browser requests");
    return { success: true, guiVerified: true, checks, score: 100 };
  } catch {
    throw new Error(
      `Simulator GUI acceptance failed during ${stage}; credentials and answer withheld.`,
    );
  } finally {
    await browser?.close();
    await host?.stop();
    await simulator?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { binary: { type: "string" }, chromium: { type: "string" } },
  });
  if (!values.binary || !values.chromium)
    throw new Error("Pass --binary and --chromium executable paths.");
  console.log(
    JSON.stringify(
      await runSimulatorConsole({ binary: values.binary, chromium: values.chromium }),
      null,
      2,
    ),
  );
}
