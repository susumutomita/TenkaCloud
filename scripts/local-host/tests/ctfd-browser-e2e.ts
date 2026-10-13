/** Actual CTFd + production local-host HTTP/SQLite + real isolated Docker exercise. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import { DockerHostingEngine } from "../docker-engine";
import { startLocalHost } from "../server";
import { organizerToken } from "./organizer-login";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const theme = process.env.CTFD_E2E_THEME ?? "core";
const problemId = process.env.CTFD_E2E_PROBLEM_ID ?? "ctfd-demo";
const artifacts = join(root, ".tenkacloud/ctfd-e2e", `${theme}-${problemId}`);
const data = mkdtempSync(join(tmpdir(), "tenka-ctfd-host-"));
mkdirSync(artifacts, { recursive: true });
const host = await startLocalHost(
  root,
  {
    dataDirectory: data,
    hostname: "127.0.0.1",
    adminPort: 5197,
    participantPort: 5198,
    gatewayPorts: { start: 5200, end: 5239 },
  },
  (directory) =>
    new DockerHostingEngine(
      problemId === "ctfd-demo" ? join(root, "integrations/ctfd/tests/fixture-root") : root,
      directory,
      // eslint-disable-next-line sonarjs/no-hardcoded-ip -- Disposable fixture pool; the allocator checks occupied subnets.
      process.env.HOST_DOCKER_NETWORK_POOL ?? "10.240.0.0/16",
    ),
  () => undefined,
);
const token = await organizerToken({ admin: host.admin.origin, key: host.organizerKey ?? "" });
async function admin(method: string, path: string, body = {}) {
  const response = await fetch(`${host.admin.origin}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `Admin ${method} ${path}: ${response.status}`);
  return response.json();
}
const event = (await admin("POST", "/events", {
  name: "CTFd isolated browser rehearsal",
  scoringAuthority: "ctfd",
  teams: [{ internalSlug: "team-a" }, { internalSlug: "team-b" }],
  problems: [{ problemId }],
})) as { eventId: string; teams: { teamId: string; teamLoginKey: string }[] };
async function waitForJobs(status: string) {
  for (let count = 0; count < 120; count += 1) {
    const detail = (await admin("GET", `/events/${event.eventId}`)) as {
      deploymentsByProblem: Record<string, { status: string }[]>;
    };
    const jobs = Object.values(detail.deploymentsByProblem).flat();
    assert.ok(
      jobs.every((job) => job.status !== "FAILED"),
      "Docker job failed; retained ownership requires inspection.",
    );
    if (jobs.length === 2 && jobs.every((job) => job.status === status)) return;
    await Bun.sleep(500);
  }
  throw new Error(`Docker jobs did not reach ${status}.`);
}
const ctfdPort = 5199;
const ctfdOrigin = `http://127.0.0.1:${ctfdPort}`;
const python = process.env.CTFD_PYTHON ?? join(root, ".cache/ctfd/venv/bin/python");
const ctfdRoot = process.env.CTFD_ROOT ?? join(root, ".cache/ctfd/run");
const ctfd = Bun.spawn([python, join(root, "integrations/ctfd/tests/serve_ctfd.py")], {
  cwd: ctfdRoot,
  env: {
    ...process.env,
    PYTHONPATH: ctfdRoot,
    TENKACLOUD_PARTICIPANT_URL: `${host.participant.origin}/api`,
    TENKACLOUD_EVENT_ID: event.eventId,
    CTFD_E2E_PORT: String(ctfdPort),
    CTFD_E2E_THEME: theme,
    CTFD_E2E_PROBLEM_ID: problemId,
  },
  stdout: Bun.file(join(artifacts, "ctfd.log")),
  stderr: Bun.file(join(artifacts, "ctfd-errors.log")),
});
const browser = await chromium.launch({
  executablePath:
    process.env.HOST_E2E_CHROMIUM ??
    (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
  headless: true,
});
const errors: string[] = [];
async function capture(page: Page, name: string) {
  const text = await page.locator("body").innerText();
  assert.ok(!event.teams.some((team) => text.includes(team.teamLoginKey)));
  await page.screenshot({
    path: join(artifacts, name),
    fullPage: true,
    mask: [page.locator("#tenkacloud-key"), page.locator("#challenge-input")],
  });
}
try {
  await admin("POST", `/events/${event.eventId}/deploy`);
  await waitForJobs("STOPPED");
  await admin("PATCH", `/events/${event.eventId}/schedule`, { startNow: true });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (ctfd.exitCode !== null) throw new Error("CTFd exited; inspect the rehearsal error log.");
    try {
      const response = await fetch(`${ctfdOrigin}/login`);
      if (response.ok) break;
    } catch {
      /* Readiness only; the test still fails if the login never opens. */
    }
    await Bun.sleep(250);
  }
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${ctfdOrigin}/login`);
  await page.locator("#name").fill("user");
  await page.locator("#password").fill("isolated-rehearsal-only");
  await page.locator("#_submit").click();
  await page.waitForURL(/\/challenges$/u);
  await page.getByRole("button", { name: /CTFd isolated exercise/u }).click();
  await page.getByRole("button", { name: "Start environment", exact: true }).waitFor();
  await capture(page, "01-challenge.png");
  const first = event.teams[0];
  const second = event.teams[1];
  assert.ok(first && second);
  await page.locator("#tenkacloud-key").fill("invalid");
  await page.getByRole("button", { name: "Refresh environment" }).click();
  await page.getByText("Enter the existing TenkaCloud team login key.", { exact: true }).waitFor();
  try {
    await page.locator("#tenkacloud-key").fill(first.teamLoginKey);
  } catch {
    throw new Error("Could not enter the isolated team key.");
  }
  await page.locator("#challenge-input").fill("not-running");
  await page.locator("#challenge-submit").click();
  await page
    .getByText("Start your environment before submitting a flag.", { exact: true })
    .waitFor();
  if (theme === "core")
    assert.equal(
      await page.locator('[x-text="attempts"]').innerText(),
      "0",
      "Unavailable verification does not consume UI attempts.",
    );
  await page.getByRole("button", { name: "Start environment", exact: true }).click();
  await page.getByText("Environment: running", { exact: true }).waitFor({ timeout: 120_000 });
  const firstLink = await page.getByRole("link", { name: "Web", exact: true }).getAttribute("href");
  assert.ok(firstLink);
  await capture(page, "02-running.png");
  const exercise = await context.newPage();
  await exercise.goto(firstLink);
  let flag: string;
  if (problemId === "ctfd-demo") {
    flag = await exercise.locator("#exercise-flag").innerText();
    assert.equal(flag, "TC{ctfd-local-e2e}");
  } else {
    await exercise.getByLabel("Username", { exact: true }).fill("admin' --");
    await exercise.getByLabel("Password", { exact: true }).fill("isolated-test");
    await exercise.getByRole("button", { name: "Sign in", exact: true }).click();
    const result = JSON.parse(await exercise.locator("body").innerText()) as { flag: string };
    assert.equal(typeof result.flag, "string", "The isolated exercise exposes its generated flag.");
    flag = result.flag;
  }
  await exercise.close();
  await page.locator("#challenge-input").fill("wrong");
  await page.locator("#challenge-submit").click();
  await page.getByText(/^Incorrect/u).waitFor();
  await page.locator("#challenge-input").fill(flag);
  await page.locator("#challenge-submit").click();
  await page.getByText("Correct", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Stop environment", exact: true }).click();
  await page.getByText("Environment: stopped", { exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(await page.getByRole("link", { name: "Web", exact: true }).count(), 0);
  let stoppedReachable = false;
  try {
    stoppedReachable = (await fetch(firstLink)).ok;
  } catch {
    // Stopping closes the team's owned gateway listener.
  }
  assert.equal(stoppedReachable, false, "Stopped gateway cannot serve the exercise.");
  await capture(page, "03-stopped.png");
  const keyInput = await page.locator("#tenkacloud-key").elementHandle();
  assert.ok(keyInput);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForTimeout(400);
  assert.equal(await keyInput.inputValue(), "", "Closing clears the key.");
  // Same document: verify the original CTFd submit function is restored after close.
  await page.getByRole("button", { name: /Standard regression/u }).click();
  await page.locator("#challenge-input").fill("TC{standard-fixture}");
  await page.locator("#challenge-submit").click();
  await page.getByText("Correct", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.goto(`${ctfdOrigin}/scoreboard`);
  await page
    .getByRole("row")
    .filter({ hasText: "user" })
    .getByText("105", { exact: true })
    .waitFor();
  await capture(page, "04-scoreboard.png");
  // A separate team key starts a different retained Docker job and exercise access URL.
  const startSecond = await fetch(
    `${host.participant.origin}/api/portal/me/problems/${problemId}/container/start`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${second.teamLoginKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  assert.equal(startSecond.status, 202);
  let secondLink: string | undefined;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch(`${host.participant.origin}/api/portal/me`, {
      headers: { Authorization: `Bearer ${second.teamLoginKey}` },
    });
    const state = (await response.json()) as {
      problems: { containerSession?: { status: string }; stackOutputs: Record<string, string> }[];
    };
    const problem = state.problems[0];
    if (attempt % 20 === 0)
      console.log(`Second team state: ${problem?.containerSession?.status ?? "missing"}`);
    if (problem?.containerSession?.status === "error") {
      const detail = (await admin("GET", `/events/${event.eventId}`)) as {
        deploymentsByProblem: Record<string, { error?: string }[]>;
      };
      const reason = Object.values(detail.deploymentsByProblem)
        .flat()
        .find((job) => job.error)?.error;
      throw new Error(`Second team's Docker fixture failed: ${reason ?? "inspect retained state"}`);
    }
    if (problem?.containerSession?.status === "running") {
      secondLink = problem.stackOutputs.Web;
      break;
    }
    await Bun.sleep(500);
  }
  assert.ok(secondLink && secondLink !== firstLink, "Teams have independent exercise URLs.");
  for (const team of event.teams) {
    const state = (await (
      await fetch(`${host.participant.origin}/api/portal/me/score-events`, {
        headers: { Authorization: `Bearer ${team.teamLoginKey}` },
      })
    ).json()) as { entries: unknown[] };
    assert.deepEqual(state.entries, [], "CTFd scoring does not write a TenkaCloud score event.");
  }
  assert.deepEqual(errors, []);
  await context.close();
  await admin("POST", `/events/${event.eventId}/end`);
  await admin("DELETE", `/events/${event.eventId}`);
  await waitForJobs("DELETED");
  writeFileSync(
    join(artifacts, "result.json"),
    JSON.stringify(
      {
        ctfdVersion: "3.8.2",
        theme,
        problemId,
        scoring: "container verdict; CTFd owns scores",
        engine: "real Docker",
        challengeDisplayed: true,
        started: true,
        wrongFlagRejected: true,
        ctfdScore: 100,
        standardRegressionScore: 5,
        scoreboardTotal: 105,
        unavailableVerdictConsumesAttempt: false,
        tenkaCloudScores: [0, 0],
        stopped: true,
        keyClearedOnClose: true,
        distinctTeamEnvironments: true,
        organizerTeardown: "DELETED",
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "CTFd browser rehearsal passed: real Docker, display/start/flag/score/stop/teardown.",
  );
} finally {
  await browser.close();
  ctfd.kill();
  await ctfd.exited;
  let cleaned = false;
  try {
    const detail = (await admin("GET", `/events/${event.eventId}`)) as { status: string };
    if (detail.status !== "TEARDOWN") {
      await admin("POST", `/events/${event.eventId}/end`);
      await admin("DELETE", `/events/${event.eventId}`);
    }
    await waitForJobs("DELETED");
    cleaned = true;
  } finally {
    await host.stop();
    if (cleaned) rmSync(data, { recursive: true, force: true });
    else console.error(`Fixture ownership retained for inspection at ${data}.`);
  }
}
