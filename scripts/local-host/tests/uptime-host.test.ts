import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProbeFn } from "../../lib/http-probe-client";
import { apiRequest, HOST_KEY } from "../bench/state-setup";
import { CloudFormationEngine } from "../cloudformation-engine";
import { CompetitionEngine } from "../competition-engine";
import { startHttpHost } from "../http";
import { probePublicEndpoint, publicEndpointUrl } from "../public-probe";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { DisruptionAws } from "./disruption-fixture";
import { FakeAws } from "./fake-aws";
import { bootstrapOrganizer } from "./organizer-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("production uptime transport rejects local, metadata, and credentialed URLs", async () => {
  for (const url of [
    /* eslint-disable sonarjs/no-clear-text-protocols -- Rejected SSRF inputs; assertions verify no connection is made. */
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/",
    "http://[::1]/",
    /* eslint-enable sonarjs/no-clear-text-protocols */
    "http://user:pass@example.com/",
    "file:///etc/passwd",
    "http://localhost/",
  ]) {
    expect(publicEndpointUrl(url)).toBeUndefined();
    expect((await probePublicEndpoint(url)).ok).toBe(false);
  }
  expect(publicEndpointUrl("https://service.example.com/healthz")?.hostname).toBe(
    "service.example.com",
  );
});

test("Battle endpoint registration scores the current minute once after EC2 readiness", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tenka-uptime-"));
  const databasePath = join(directory, "host.sqlite");
  let store = new HostStore(new Database(databasePath));
  let listener: Awaited<ReturnType<typeof startHttpHost>> | undefined;
  let clock = Date.parse("2026-09-30T00:00:00.000Z");
  let ready = false;
  let frontendHealthy = true;
  const disruption = new DisruptionAws();
  let holdFrontend: Promise<void> | undefined;
  let frontendSeen: (() => void) | undefined;
  const calls: string[] = [];
  const probe: ProbeFn = async (url) => {
    calls.push(url);
    if (url.includes("frontend") && holdFrontend) {
      frontendSeen?.();
      await holdFrontend;
    }
    const ok = url.includes("ec2-")
      ? ready && (url.includes(":8080") || disruption.running.get("i-0123456789abcdef0") !== false)
      : !url.includes("frontend") || frontendHealthy;
    return { ok, status: ok ? 200 : 503, responseTimeMs: 1 };
  };
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
  const engine = new CompetitionEngine(root, directory, false, cloud);
  engine.disruptionAdapter = () => disruption.adapter();
  const service = new HostingService(
    store,
    engine,
    HOST_KEY,
    () => clock,
    () => undefined,
    probe,
  );
  service.accountConnection = {
    region: "ap-northeast-1",
    operatorAccountId: "999999999999",
    externalId: "host-external-id-0123456789",
    verify: async () => undefined,
  };
  try {
    const admin = await bootstrapOrganizer(service, HOST_KEY);
    const request = (method: string, path: string, body: Record<string, unknown> = {}) =>
      service.admin(apiRequest({ method, path, token: admin, body }));
    expect(
      (await request("POST", "/admin/competitor-accounts", { awsAccountId: "111111111111" }))
        .status,
    ).toBe(201);
    expect((await request("POST", "/admin/competitor-accounts/111111111111/verify")).status).toBe(
      200,
    );
    const created = await request("POST", "/events", {
      name: "uptime",
      teams: [{ internalSlug: "alpha", awsAccountId: "111111111111" }],
      problems: [{ problemId: "hello-world-battle" }, { problemId: "hello-world" }],
    });
    expect(created.status).toBe(201);
    const event = created.body as {
      eventId: string;
      teams: { teamId: string; teamLoginKey: string }[];
    };
    const team = event.teams[0];
    if (!team) throw new Error("Missing fixture team");
    await request("POST", `/events/${event.eventId}/deploy`);
    await service.drain();
    expect(store.event(event.eventId).status).toBe("READY");
    await request("PATCH", `/events/${event.eventId}/schedule`, { startNow: true });
    listener = await startHttpHost({
      kind: "participant",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot: root,
      service,
    });
    const endpoint = `/api/portal/me/problems/hello-world-battle/endpoints`;
    const http = async (method: string, path: string, body?: Record<string, unknown>) => {
      const response = await fetch(`${listener?.origin}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${team.teamLoginKey}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    expect((await http("GET", endpoint)).status).toBe(200);
    expect(
      (await http("POST", `${endpoint}/frontend`, { url: "https://frontend.example.com" })).status,
    ).toBe(200);
    await service.uptime.tick();
    expect(calls).toEqual([]);
    expect(store.team(team.teamId).score).toBe(0);
    const registered = await http("POST", `${endpoint}/api`, { url: "https://api.example.com" });
    expect(registered.status).toBe(200);
    expect(
      (registered.body.endpoints as { overrideUrl?: string }[]).map((entry) => entry.overrideUrl),
    ).toEqual(["https://frontend.example.com", "https://api.example.com"]);
    await service.uptime.tick();
    expect(calls).toHaveLength(2);
    expect(store.team(team.teamId).score).toBe(0);
    ready = true;
    await service.uptime.tick();
    expect(store.team(team.teamId).score).toBe(100);
    expect(
      store.uptimeObserved(
        event.eventId,
        team.teamId,
        "hello-world-battle",
        Math.floor(clock / 60_000),
      ),
    ).toBe(true);
    await service.uptime.tick();
    expect(store.team(team.teamId).score).toBe(100);
    clock += 60_000;
    frontendHealthy = false;
    await service.uptime.tick();
    expect(store.team(team.teamId).score).toBe(0);
    expect(store.team(team.teamId).scoreEvents.map((entry) => entry.points)).toEqual([-100, 100]);
    clock += 60_000;
    let release: () => void = () => undefined;
    holdFrontend = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      frontendSeen = resolve;
    });
    const staleTick = service.uptime.tick();
    await seen;
    expect(
      (await http("POST", `${endpoint}/frontend`, { url: "https://frontend-new.example.com" }))
        .status,
    ).toBe(200);
    release();
    await staleTick;
    holdFrontend = undefined;
    frontendSeen = undefined;
    expect(store.team(team.teamId).score).toBe(0);
    expect(
      store.uptimeObserved(
        event.eventId,
        team.teamId,
        "hello-world-battle",
        Math.floor(clock / 60_000),
      ),
    ).toBe(false);
    frontendHealthy = true;
    await service.uptime.tick();
    expect(store.team(team.teamId).score).toBe(100);
    await listener.close();
    listener = undefined;
    store.close();
    store = new HostStore(new Database(databasePath));
    const restarted = new HostingService(
      store,
      engine,
      HOST_KEY,
      () => clock,
      () => undefined,
      probe,
    );
    await restarted.uptime.tick();
    expect(store.team(team.teamId).score).toBe(100);
    expect(store.team(team.teamId).scoreEvents).toHaveLength(3);
    const configure = (path: string, body: unknown) =>
      restarted.admin(apiRequest({ method: "PUT", path, token: admin, body }));
    expect(
      (await configure("/feature-flags", { key: "challengePrerequisiteGate", enabled: true }))
        .status,
    ).toBe(200);
    expect(
      (
        await configure(`/events/${event.eventId}/progression-gate`, {
          gateProblemId: "hello-world",
          unlockTargetIds: ["hello-world-battle"],
          defaultPolicy: "required",
        })
      ).status,
    ).toBe(200);
    clock += 60_000;
    const callsBeforeLock = calls.length;
    await restarted.uptime.tick();
    expect(calls).toHaveLength(callsBeforeLock);
    expect(store.team(team.teamId).score).toBe(100);
    expect(
      (await configure("/feature-flags", { key: "challengePrerequisiteGate", enabled: false }))
        .status,
    ).toBe(200);
    const fired = await restarted.admin(
      apiRequest({
        method: "POST",
        path: `/events/${event.eventId}/disruptions/fire`,
        token: admin,
        body: {
          problemId: "hello-world-battle",
          disruptionId: "frontend-down",
          scope: "all",
          requestId: "uptime-disruption-integration",
        },
      }),
    );
    expect(fired.status).toBe(202);
    disruption.now = clock;
    await restarted.disruptions.tick();
    disruption.applyEffects();
    expect(disruption.commands).toHaveLength(1);
    clock += 60_000;
    disruption.now = clock;
    await restarted.uptime.tick();
    expect(
      store.uptimeState(event.eventId, team.teamId, "hello-world-battle").hostHintHealth,
    ).toMatchObject({ frontend: false, api: true });
    expect(store.team(team.teamId).score).toBe(200);
    expect(
      JSON.parse(
        store.uptimeState(event.eventId, team.teamId, "hello-world-battle").endpointsHealth ?? "{}",
      ),
    ).toMatchObject({ frontend: { ok: true }, api: { ok: true } });
    clock += 600_000;
    disruption.now = clock;
    await restarted.disruptions.tick();
    disruption.applyEffects();
    await restarted.disruptions.tick();
    expect(disruption.commands).toHaveLength(2);
    expect(restarted.disruptions.store.executions(event.eventId)[0]?.status).toBe(
      "revert_command_completed",
    );
    await restarted.uptime.tick();
    expect(
      store.uptimeState(event.eventId, team.teamId, "hello-world-battle").hostHintHealth,
    ).toMatchObject({ frontend: true, api: true });
    clock += 60_000;
    const beforeRollback = store.team(team.teamId).scoreEvents.length;
    const captureTriggers = restarted.disruptions.captureTriggers.bind(restarted.disruptions);
    restarted.disruptions.captureTriggers = () => {
      throw new Error("fixture capture failure");
    };
    await restarted.uptime.tick();
    expect(store.team(team.teamId).scoreEvents).toHaveLength(beforeRollback);
    expect(
      store.uptimeObserved(
        event.eventId,
        team.teamId,
        "hello-world-battle",
        Math.floor(clock / 60_000),
      ),
    ).toBe(false);
    restarted.disruptions.captureTriggers = captureTriggers;
    await restarted.uptime.tick();
    expect(store.team(team.teamId).scoreEvents).toHaveLength(beforeRollback + 1);
  } finally {
    await listener?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
