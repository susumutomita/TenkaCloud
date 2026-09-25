/** Runs the production adapter and the catalog's unmodified Docker problem.
 * Requires Bun, the checked-out problems submodule and a working Docker daemon.
 * There is deliberately no fake runtime or skip-on-failure path in this check. */
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveComposeCli } from "../../local-play/docker-adapter";
import { randomToken } from "../auth";
import { DAEMON_UNAVAILABLE_MESSAGE, DockerHostingEngine } from "../docker-engine";
import { persistentKey, prepareDatabase, privateDirectory } from "../files";
import { DEFAULT_GATEWAY_PORTS, parseGatewayPorts } from "../gateway-ports";
import { SurfaceGateways } from "../gateways";
import { type HttpHost, startHttpHost } from "../http";
import { object, type Team } from "../model";
import { HostingService } from "../service";
import { HostStore } from "../store";

interface CreatedEvent {
  eventId: string;
  teams: {
    teamId: string;
    teamLoginKey: string;
  }[];
}

interface TeamView {
  problems: {
    stackOutputs: Record<string, string>;
    score: number;
  }[];
}

/** The host's real range by default; CI can move it when another service holds those ports. */
function smokeGatewayPorts() {
  return parseGatewayPorts(process.env.HOST_GATEWAY_PORTS ?? DEFAULT_GATEWAY_PORTS);
}

/** Container IDs of one job's Compose project, asked from the daemon, not from our records. */
function projectContainers(jobId: string, includeStopped = false): string[] {
  // The label filter needs the Docker CLI itself (the Compose plugin's host command).
  const cli = resolveComposeCli();
  assert.equal(cli.command, "docker", "The Docker smoke needs the docker CLI.");
  const result = spawnSync(
    cli.command,
    [
      "ps",
      ...(includeStopped ? ["-a"] : []),
      "-q",
      "--filter",
      `label=com.docker.compose.project=tch-${jobId.toLowerCase()}`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const parent = join(root, ".tenkacloud");
  mkdirSync(parent, { recursive: true });
  // mkdtemp creates the directory with mode 0700; privateDirectory only verifies it.
  const directory = privateDirectory(mkdtempSync(join(parent, "host-docker-smoke-")));
  const databasePath = join(directory, "hosting.sqlite");
  prepareDatabase(databasePath);
  const masterKey = persistentKey(join(directory, "host-key"));
  let store = new HostStore(new Database(databasePath, { create: true, strict: true }));
  let engine = new DockerHostingEngine(root, directory);
  const gatewayPorts = smokeGatewayPorts();
  let service = new HostingService(store, engine, masterKey);
  service.gatewayPorts = gatewayPorts;
  let surfaces = new SurfaceGateways("127.0.0.1", service, gatewayPorts);
  let host: HttpHost | undefined;
  let portal: HttpHost | undefined;
  let accessToken = "";
  let eventId = "";
  const checks: string[] = [];
  let failed = false;
  async function attach(): Promise<void> {
    const currentSurfaces = surfaces;
    service.surfaceLink = (job, team) => currentSurfaces.link(job, team);
    service.closeSurface = (jobId) => currentSurfaces.closeJob(jobId);
    const staticRoot = join(directory, "static");
    mkdirSync(staticRoot, { recursive: true });
    // No browser-UI claim: this test exercises the real HTTP APIs and Docker target.
    writeFileSync(
      join(staticRoot, "host.html"),
      "<!doctype html><title>Docker integration check</title>",
    );
    portal = await startHttpHost({
      kind: "participant",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot,
      service,
    });
    host = await startHttpHost({
      kind: "admin",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot,
      service,
      participantOrigin: portal.origin,
    });
  }
  async function api<Body>(
    role: "host" | "portal",
    path: string,
    method = "GET",
    body?: unknown,
    credential?: string,
  ): Promise<Body> {
    const endpoint = role === "host" ? host : portal;
    assert.ok(endpoint);
    const token = credential ?? (role === "host" ? accessToken : "");
    const response = await fetch(`${endpoint.origin}/api${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload: unknown = await response.json();
    assert.ok(response.ok, `HTTP ${response.status}: ${JSON.stringify(payload)}`);
    return payload as Body;
  }
  async function login(): Promise<void> {
    const session = await api<{ idToken: string }>(
      "host",
      "/host/login",
      "POST",
      { key: masterKey },
      "",
    );
    accessToken = session.idToken;
  }
  async function solve(team: { teamLoginKey: string }): Promise<string> {
    const view = await api<TeamView>("portal", "/portal/me", "GET", undefined, team.teamLoginKey);
    const link = view.problems[0]?.stackOutputs.Web;
    assert.ok(link, "The real portal view must expose this team's authorized surface.");
    const handoff = await fetch(link, { redirect: "manual" });
    assert.equal(handoff.status, 303);
    await handoff.text();
    const cookie = handoff.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const origin = new URL(link).origin;
    const response = await fetch(`${origin}/login`, {
      method: "POST",
      headers: {
        cookie,
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ username: "admin' --", password: randomToken() }),
    });
    assert.equal(response.status, 200);
    const result = object(await response.json());
    assert.equal(typeof result.flag, "string");
    return String(result.flag);
  }
  async function restart(): Promise<void> {
    await service.drain();
    await Promise.all([host?.close(), portal?.close()]);
    host = undefined;
    portal = undefined;
    await surfaces.close();
    store.close();
    store = new HostStore(new Database(databasePath, { create: true, strict: true }));
    engine = new DockerHostingEngine(root, directory);
    service = new HostingService(store, engine, masterKey);
    service.gatewayPorts = gatewayPorts;
    await service.recover();
    surfaces = new SurfaceGateways("127.0.0.1", service, gatewayPorts);
    await attach();
    await login();
  }
  /** Real CLI, unreachable daemon: the cause is reported, and the advised retry recovers. */
  async function checkNoDaemonRecovery(): Promise<void> {
    const saved = process.env.DOCKER_HOST;
    process.env.DOCKER_HOST = "unix:///nonexistent/tenkacloud-no-daemon.sock";
    let unavailable: CreatedEvent;
    try {
      unavailable = await api<CreatedEvent>("host", "/events", "POST", {
        name: "Docker daemon outage",
        teams: [{ internalSlug: "solo" }],
        problems: [{ problemId: "sqli-demo" }],
      });
      await api("host", `/events/${unavailable.eventId}/deploy`, "POST", {});
      await service.drain();
    } finally {
      if (saved === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = saved;
    }
    const [failedJob] = store.jobs(unavailable.eventId);
    assert.equal(failedJob?.status, "FAILED");
    assert.equal(failedJob?.error, DAEMON_UNAVAILABLE_MESSAGE);
    assert.ok(failedJob?.unit, "Ownership is retained while cleanup could not run.");
    await api("host", `/events/${unavailable.eventId}/deploy`, "POST", {});
    await service.drain();
    assert.equal(
      store.job(failedJob.jobId).status,
      "COMPLETE",
      store.job(failedJob.jobId).error ?? "",
    );
    assert.equal(store.event(unavailable.eventId).status, "READY");
    await api("host", `/events/${unavailable.eventId}`, "DELETE", {});
    await service.drain();
    assert.equal(store.job(failedJob.jobId).status, "DELETED");
    assert.deepEqual(projectContainers(failedJob.jobId, true), []);
    checks.push(
      "An unreachable Docker daemon is reported as the cause; the advised retry then deploys and tears down for real",
    );
  }
  /** Operating on one team's environment must not touch the other team's Docker project. */
  async function checkTeamIsolation(
    first: CreatedEvent["teams"][number],
    second: CreatedEvent["teams"][number],
    flagA: string,
    flagB: string,
  ): Promise<void> {
    const jobA = store.jobs(eventId, first.teamId)[0]?.jobId ?? "";
    const jobB = store.jobs(eventId, second.teamId)[0]?.jobId ?? "";
    const scores = () => [store.team(first.teamId).score, store.team(second.teamId).score];
    const scoresBefore = scores();
    const containersB = projectContainers(jobB);
    assert.ok(containersB.length > 0);
    const operate = async (method: string, suffix: string) => {
      await api("host", `/events/${eventId}/deployments/${jobA}${suffix}`, method, {});
      await service.drain();
    };
    const expectTeamBUntouched = async () => {
      assert.equal(store.job(jobB).status, "COMPLETE");
      assert.deepEqual(projectContainers(jobB), containersB);
      assert.equal(await solve(second), flagB);
      assert.deepEqual(scores(), scoresBefore);
    };
    await operate("POST", "/stop");
    assert.equal(store.job(jobA).status, "STOPPED", store.job(jobA).error ?? "");
    assert.deepEqual(projectContainers(jobA), []);
    assert.ok(projectContainers(jobA, true).length > 0, "Stop keeps the containers.");
    await expectTeamBUntouched();
    await operate("POST", "/restart");
    assert.equal(store.job(jobA).status, "COMPLETE", store.job(jobA).error ?? "");
    assert.equal(await solve(first), flagA);
    await expectTeamBUntouched();
    await operate("DELETE", "");
    assert.equal(store.job(jobA).status, "DELETED", store.job(jobA).error ?? "");
    assert.deepEqual(projectContainers(jobA, true), []);
    await expectTeamBUntouched();
    await operate("POST", "/restart");
    assert.equal(store.job(jobA).status, "COMPLETE", store.job(jobA).error ?? "");
    assert.match(await solve(first), /^TC\{/u);
    await expectTeamBUntouched();
    checks.push(
      "Stopping, restarting and removing team A's Docker environment leaves team B's containers, gateway and score unchanged",
    );
  }
  try {
    await attach();
    await login();
    await checkNoDaemonRecovery();
    const event = await api<CreatedEvent>("host", "/events", "POST", {
      name: "Production Docker integration check",
      teams: [{ internalSlug: "team-a" }, { internalSlug: "team-b" }],
      problems: [{ problemId: "sqli-demo", defaultRegion: "local" }],
    });
    eventId = event.eventId;
    const [first, second] = event.teams;
    assert.ok(first && second);
    await api("host", `/events/${eventId}/deploy`, "POST", {});
    await service.drain();
    const jobs = store.jobs(eventId);
    assert.equal(jobs.length, 2);
    assert.ok(
      jobs.every((job) => job.status === "COMPLETE" && job.unit),
      JSON.stringify(jobs.map((job) => ({ status: job.status, error: job.error }))),
    );
    assert.notEqual(jobs[0]?.offset, jobs[1]?.offset);
    checks.push(
      "Two production Docker environments, separate projects/ports and durable ownership",
    );
    await api("host", `/events/${eventId}/schedule`, "PATCH", {
      startNow: true,
      endsAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    const flagA = await solve(first);
    const flagB = await solve(second);
    assert.notEqual(flagA, flagB);
    checks.push(
      "Unmodified sqli-demo solved over isolated authorized HTTP gateways; per-team secrets differ",
    );
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        api<{ kind: string }>(
          "portal",
          "/portal/me/submit-flag",
          "POST",
          { problemId: "sqli-demo", flag: flagA },
          first.teamLoginKey,
        ),
      ),
    );
    assert.equal(results.filter((result) => result.kind === "ok").length, 1);
    assert.equal(store.team(first.teamId).score, 100);
    assert.equal(store.team(first.teamId).scoreEvents.length, 1);
    const wrong = await api<{ kind: string }>(
      "portal",
      "/portal/me/submit-flag",
      "POST",
      { problemId: "sqli-demo", flag: flagA },
      second.teamLoginKey,
    );
    assert.equal(wrong.kind, "wrong");
    assert.equal(store.team(second.teamId).score, -5);
    checks.push(
      "Repository scorer/verifier reused; concurrent submissions award once and a foreign flag is rejected",
    );
    await restart();
    assert.equal(store.team(first.teamId).score, 100);
    assert.equal(store.team(second.teamId).score, -5);
    assert.equal(await solve(first), flagA);
    assert.equal(await solve(second), flagB);
    checks.push(
      "New production adapter instance recovers real running Docker projects and SQLite progress",
    );
    await checkTeamIsolation(first, second, flagA, flagB);
    await api("host", `/events/${eventId}/end`, "POST", {});
    await restart();
    assert.equal(store.event(eventId).status, "ENDED");
    await api("host", `/events/${eventId}`, "DELETE", {});
    await service.drain();
    assert.ok(store.jobs(eventId).every((job) => job.status === "DELETED" && job.unit === null));
    const persisted: Team = store.team(first.teamId);
    assert.equal(persisted.score, 100);
    checks.push(
      "End state survives restart; physical teardown removes owned environments without deleting results",
    );
    console.log(checks.map((check) => `PASS ${check}`).join("\n"));
    if (process.env.HOST_DOCKER_REPORT)
      writeFileSync(
        process.env.HOST_DOCKER_REPORT,
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            runtime: "Bun",
            checks,
            status: "passed",
          },
          null,
          2,
        ),
      );
  } catch (error) {
    failed = true;
    console.error("Production Docker smoke failed:", error);
    throw error;
  } finally {
    await service.drain();
    await Promise.all([host?.close(), portal?.close()]);
    await surfaces.close();
    const cleanupErrors: unknown[] = [];
    for (const job of store.closed ? [] : store.jobs()) {
      if (!job.unit) continue;
      try {
        await engine.stop(job);
        job.unit = null;
        job.status = "DELETED";
        store.putJob(job);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    store.close();
    if (cleanupErrors.length) {
      console.error(`Cleanup failed; ownership records remain in ${directory}.`);
      if (!failed) process.exitCode = 1;
    } else rmSync(directory, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
