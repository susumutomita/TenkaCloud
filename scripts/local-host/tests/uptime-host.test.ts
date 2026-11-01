import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillEvidenceInput } from "../../../apps/application-admin-console/src/lib/skill-evidence";
import { buildSkillEvidence } from "../../../apps/application-admin-console/src/lib/skill-evidence";
import type { ProbeFn } from "../../lib/http-probe-client";
import { id } from "../auth";
import { apiRequest, HOST_KEY, loginAdmin } from "../bench/state-setup";
import { CompetitionEngine } from "../competition-engine";
import { startHttpHost } from "../http";
import { probePublicEndpoint, publicEndpointUrl } from "../public-probe";
import { HostingService } from "../service";
import { HostStore } from "../store";
import {
  LEGACY_FLAG_STACK,
  LEGACY_UPTIME_STACK,
  legacyStackProblem,
  seedLegacyAwsEvent,
} from "./legacy-aws-fixture";

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

test("Battle endpoint registration on a saved uptime stack scores the current minute once after EC2 readiness", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tenka-uptime-"));
  const databasePath = join(directory, "host.sqlite");
  let store = new HostStore(new Database(databasePath));
  let listener: Awaited<ReturnType<typeof startHttpHost>> | undefined;
  let clock = Date.parse("2026-09-30T00:00:00.000Z");
  let ready = false;
  let frontendHealthy = true;
  let holdFrontend: Promise<void> | undefined;
  let frontendSeen: (() => void) | undefined;
  const calls: string[] = [];
  const probe: ProbeFn = async (url) => {
    calls.push(url);
    if (url.includes("frontend") && holdFrontend) {
      frontendSeen?.();
      await holdFrontend;
    }
    const ok = url.includes("ec2-") ? ready : !url.includes("frontend") || frontendHealthy;
    return { ok, status: ok ? 200 : 503, responseTimeMs: 1 };
  };
  // Local hosting no longer deploys stacks; the job is the running stack an older revision saved.
  const engine = new CompetitionEngine(root, directory, false);
  const { event, team } = seedLegacyAwsEvent(store, {
    eventId: id(clock),
    teamId: id(clock),
    now: clock,
    problems: [legacyStackProblem(LEGACY_UPTIME_STACK), legacyStackProblem(LEGACY_FLAG_STACK)],
    outputs: {
      FrontendUrl: "",
      ApiUrl: "",
      Ec2HostHint: "ec2-203-0-113-10.example.com",
      InstanceId: "i-0123456789abcdef0",
    },
  });
  const service = new HostingService(
    store,
    engine,
    HOST_KEY,
    () => clock,
    () => undefined,
    probe,
  );
  try {
    const admin = await loginAdmin(service);
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
          Authorization: `Bearer ${team.loginKey}`,
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
    const report = await restarted.admin(
      apiRequest({
        method: "GET",
        path: `/events/${event.eventId}`,
        token: admin,
        query: new URLSearchParams({ withScoreEvents: "true" }),
      }),
    );
    const evidence = buildSkillEvidence(report.body as SkillEvidenceInput).find(
      (row) => row.problemId === "hello-world-battle",
    );
    expect(evidence?.status).toBe("demonstrated");
    expect(evidence?.englishLabel).toBe("Successful probe of a registered service endpoint");
    expect(evidence?.observations).toHaveLength(3);

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
    clock += 60_000;
    await restarted.uptime.tick();
    expect(store.team(team.teamId).score).toBe(200);
    expect(
      store.uptimeState(event.eventId, team.teamId, "hello-world-battle").hostHintHealth,
    ).toMatchObject({ frontend: true, api: true });
    expect(
      JSON.parse(
        store.uptimeState(event.eventId, team.teamId, "hello-world-battle").endpointsHealth ?? "{}",
      ),
    ).toMatchObject({ frontend: { ok: true }, api: { ok: true } });
    // A failure after the score write rolls the whole minute back; the next tick retries it.
    clock += 60_000;
    const beforeRollback = store.team(team.teamId).scoreEvents.length;
    const captureTeam = restarted.progression.captureTeam.bind(restarted.progression);
    restarted.progression.captureTeam = () => {
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
    restarted.progression.captureTeam = captureTeam;
    await restarted.uptime.tick();
    expect(store.team(team.teamId).scoreEvents).toHaveLength(beforeRollback + 1);
  } finally {
    await listener?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
