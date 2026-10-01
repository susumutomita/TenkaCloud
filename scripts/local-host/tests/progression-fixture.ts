import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CloudFormationEngine } from "../cloudformation-engine";
import { CompetitionEngine } from "../competition-engine";
import { type HttpHost, startHttpHost } from "../http";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { FakeAws } from "./fake-aws";
import { organizerToken } from "./organizer-login";

export const GATE = "challengePrerequisiteGate";
export const START = Date.parse("2026-09-30T00:00:00Z");
export interface CreatedEvent {
  eventId: string;
  teams: { teamId: string; teamLoginKey: string }[];
}

/** Real host HTTP, SQLite, metadata and scorers. Only outbound AWS transport is replaced. */
export async function progressionFixture(
  options: { adminBuild?: string; participantBuild?: string } = {},
) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const data = mkdtempSync(join(tmpdir(), "tenka-progression-"));
  const filename = join(data, "host.sqlite");
  let store = new HostStore(new Database(filename));
  const aws = new FakeAws();
  const cloud = new CloudFormationEngine(root, {
    region: "ap-northeast-1",
    externalId: "host-test-external-id",
    operatorAccountId: async () => "999999999999",
    sts: aws.sts as never,
    cloudFormation: aws.cloudFormation as never,
    team: (job) => store.team(job.teamId),
    sleep: async () => undefined,
    pollIntervalMs: 0,
    timeoutMs: 60_000,
  });
  const engine = new CompetitionEngine(root, data, false, cloud);
  let service = new HostingService(store, engine, "gate-test-host-key", () => START);
  let admin: HttpHost;
  let portal: HttpHost;
  let token = "";
  async function start() {
    service.accountConnection = {
      region: "ap-northeast-1",
      operatorAccountId: "999999999999",
      externalId: "host-test-external-id",
      verify: async (accountId, roleName) => {
        await aws.sts.send(
          new (await import("@aws-sdk/client-sts")).AssumeRoleCommand({
            RoleArn: `arn:aws:iam::${accountId}:role/${roleName}`,
            ExternalId: "host-test-external-id",
            RoleSessionName: "gate-test-verify",
          }),
        );
      },
    };
    portal = await startHttpHost({
      kind: "participant",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot: options.participantBuild ?? data,
      service,
    });
    admin = await startHttpHost({
      kind: "admin",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot: options.adminBuild ?? data,
      service,
      participantOrigin: portal.origin,
    });
    token = await organizerToken({ admin: admin.origin, key: "gate-test-host-key" });
    for (const awsAccountId of ["111111111111", "222222222222"]) {
      if (store.accounts().some((account) => account.awsAccountId === awsAccountId)) continue;
      const registered = await request("/admin/competitor-accounts", "POST", { awsAccountId });
      if (registered.status !== 201) throw new Error("Account registration failed.");
      const verified = await request(`/admin/competitor-accounts/${awsAccountId}/verify`, "POST");
      if (verified.status !== 200) throw new Error("Account verification failed.");
    }
  }
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    key?: string,
    nonce?: string,
  ) {
    const response = await fetch(
      `${path.startsWith("/portal/") ? portal.origin : admin.origin}/api${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${key ?? token}`,
          "content-type": "application/json",
          ...(nonce ? { "idempotency-key": nonce } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  async function stop() {
    await Promise.all([admin.close(), portal.close()]);
    await service.drain();
    service.flush();
    store.close();
  }
  await start();
  return {
    root,
    data,
    aws,
    engine,
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    request,
    get adminToken() {
      return token;
    },
    get adminOrigin() {
      return admin.origin;
    },
    get participantOrigin() {
      return portal.origin;
    },
    async create(name = "gate test"): Promise<CreatedEvent> {
      const made = await request("/events", "POST", {
        name,
        teams: [
          { internalSlug: `alpha-${name.replaceAll(" ", "-")}`, awsAccountId: "111111111111" },
          { internalSlug: `beta-${name.replaceAll(" ", "-")}`, awsAccountId: "222222222222" },
        ],
        problems: [{ problemId: "hello-world" }, { problemId: "ac26-crypto-battle" }],
      });
      if (made.status !== 201) throw new Error(JSON.stringify(made));
      const event = made.body as unknown as CreatedEvent;
      await request(`/events/${event.eventId}/deploy`, "POST", {});
      await service.drain();
      await request(`/events/${event.eventId}/schedule`, "PATCH", { startNow: true });
      return event;
    },
    flag(enabled: boolean) {
      return request("/feature-flags", "PUT", { key: GATE, enabled });
    },
    async restart() {
      await stop();
      store = new HostStore(new Database(filename));
      service = new HostingService(store, engine, "gate-test-host-key", () => START);
      await service.recover();
      await start();
    },
    async close() {
      await stop();
      rmSync(data, { recursive: true, force: true });
    },
  };
}
