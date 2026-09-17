/** Runs the production adapter and the catalog's unmodified Docker problem.
 * Requires Bun, the checked-out problems submodule and a working Docker daemon.
 * There is deliberately no fake runtime or skip-on-failure path in this check. */
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomToken } from "../auth";
import { DockerHostingEngine } from "../docker-engine";
import { persistentKey, prepareDatabase, privateDirectory } from "../files";
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
  let service = new HostingService(store, engine, masterKey);
  let surfaces = new SurfaceGateways("127.0.0.1", service);
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
    await service.recover();
    surfaces = new SurfaceGateways("127.0.0.1", service);
    await attach();
    await login();
  }
  try {
    await attach();
    await login();
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
