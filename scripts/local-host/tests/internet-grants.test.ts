/* eslint-disable sonarjs/no-hardcoded-ip -- Synthetic addresses are test data and are never contacted. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { parse } from "yaml";
import { id } from "../auth";
import { apiRequest } from "../bench/state-setup";
import type { DockerDefinition } from "../docker-catalog";
import { InternetGrantStore } from "../internet-grant-store";
import { requiredNetworkValue } from "../local-network";
import { HostError } from "../model";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { networkEngineFixture } from "./network-engine-fixture";
import { bootstrapOrganizer, createOrganizerSession } from "./organizer-fixture";

async function fixture() {
  const f = networkEngineFixture();
  const problem = { ...requiredNetworkValue(f.engine.catalog()[0]) };
  const definition: DockerDefinition = JSON.parse(problem.definition);
  const request = {
    id: "upstream",
    service: requiredNetworkValue(Object.keys(parse(definition.composeText).services)[0]),
    destination: "8.8.8.8",
    port: 443,
    purpose: "Synthetic upstream",
  };
  problem.definition = JSON.stringify({
    ...definition,
    catalogSnapshot: { root: "/synthetic", digest: "pinned-definition" },
    problem: {
      ...definition.problem,
      internetAccess: [request, { ...request, id: "ipv6", destination: "2606:4700:4700::1111" }],
    },
  });
  const eventA = { ...f.store.event("event"), eventId: id(), problems: [problem] };
  const eventB = { ...eventA, eventId: id() };
  f.store.putEvent(eventA);
  f.store.putEvent(eventB);
  const service = new HostingService(f.store, f.engine, "synthetic-host-key");
  const token = await bootstrapOrganizer(service, "synthetic-host-key");
  const api = (eventId: string, method = "GET", body?: unknown, key = token, suffix = "") =>
    service
      .admin(
        apiRequest({
          method,
          path: `/events/${eventId}/internet-access${suffix}`,
          token: key,
          body,
        }),
      )
      .catch((error: unknown) => {
        if (!(error instanceof HostError)) throw error;
        return { status: error.status, body: { message: error.message } };
      });
  return { ...f, service, eventA, eventB, problem, request, api, token };
}

test("organizer Internet API checks roles, individual requests and event isolation", async () => {
  const f = await fixture();
  try {
    const viewer = await createOrganizerSession(f.service, f.token, "internet-viewer", "Viewer");
    const operator = await createOrganizerSession(
      f.service,
      f.token,
      "internet-operator",
      "Operator",
    );
    const suffix = `/${f.problem.problemId}`;
    const read = await f.api(f.eventA.eventId, "GET", undefined, viewer.token);
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).toContain(f.request.destination);
    expect(JSON.stringify(read.body)).toContain('"grant":null');
    expect(
      (await f.api(f.eventA.eventId, "PUT", { requestIds: ["upstream"] }, viewer.token, suffix))
        .status,
    ).toBe(403);
    expect((await f.api(f.eventA.eventId, "DELETE", undefined, viewer.token, suffix)).status).toBe(
      403,
    );
    for (const requestIds of [[], ["unknown"], ["upstream", "upstream"]])
      expect(
        (await f.api(f.eventA.eventId, "PUT", { requestIds }, operator.token, suffix)).status,
      ).toBe(400);
    expect(
      (
        await f.api(
          f.eventA.eventId,
          "PUT",
          { requestIds: ["upstream"] },
          operator.token,
          "/cross-event-problem",
        )
      ).status,
    ).toBe(404);
    expect(
      (await f.api(f.eventA.eventId, "PUT", { requestIds: ["upstream"] }, operator.token, suffix))
        .status,
    ).toBe(200);
    expect(
      f.service.internetAccess.store.get(f.eventA.eventId, f.problem.problemId)?.requestIds,
    ).toEqual(["upstream"]);
    expect(
      f.service.internetAccess.store.get(f.eventB.eventId, f.problem.problemId),
    ).toBeUndefined();
    expect(JSON.stringify((await f.api(f.eventB.eventId)).body)).toContain('"grant":null');
    expect(
      (await f.api(f.eventA.eventId, "DELETE", undefined, operator.token, suffix)).status,
    ).toBe(200);
    expect(
      f.service.internetAccess.store.get(f.eventA.eventId, f.problem.problemId),
    ).toBeUndefined();
    const unknown = { ...f.eventB, problems: [] };
    f.store.putEvent(unknown);
    expect(
      (await f.api(f.eventB.eventId, "PUT", { requestIds: ["upstream"] }, operator.token, suffix))
        .status,
    ).toBe(404);
  } finally {
    await f.close();
  }
});

for (const reason of [
  "host interface",
  "LAN connected route",
  "VPN route",
  "global local table",
  "IPv6 host",
  "IPv6 LAN",
  "IPv6 VPN",
  "IPv6 local table",
  "native guard unavailable",
])
  test(`Internet approval returns 409 for live ${reason} protection`, async () => {
    const f = await fixture();
    try {
      f.guard.assertInternetTargets = () => {
        throw new Error(`protected ${reason}`);
      };
      const response = await f.api(
        f.eventA.eventId,
        "PUT",
        { requestIds: [reason.includes("IPv6") ? "ipv6" : "upstream"] },
        f.token,
        `/${f.problem.problemId}`,
      );
      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).toContain(reason);
      expect(
        f.service.internetAccess.store.get(f.eventA.eventId, f.problem.problemId),
      ).toBeUndefined();
      expect(JSON.stringify((await f.api(f.eventA.eventId)).body)).toContain('"available":false');
    } finally {
      await f.close();
    }
  });

test("Internet grant rows validate, survive reopen and cascade when their event is deleted", () => {
  const database = new Database(":memory:");
  const store = new HostStore(database);
  const grants = new InternetGrantStore(store);
  store.putEvent({
    eventId: "event",
    name: "Synthetic",
    status: "READY",
    createdAt: "now",
    updatedAt: "now",
    expiresAt: 1,
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [],
  });
  const grant = {
    eventId: "event",
    problemId: "problem",
    definitionDigest: "pinned",
    requestIds: ["one", "two"],
    grantedAt: "2026-10-16T00:00:00Z",
  };
  grants.put(grant);
  expect(new InternetGrantStore(store).get("event", "problem")).toEqual(grant);
  expect(() => grants.put({ ...grant, requestIds: ["two", "one"] })).toThrow();
  expect(() => grants.put({ ...grant, requestIds: [] })).toThrow();
  database.exec("DELETE FROM host_events WHERE id='event'");
  expect(grants.get("event", "problem")).toBeUndefined();
  store.close();
});

test("participant responses and routes never expose organizer Internet destinations", async () => {
  const f = await fixture();
  try {
    const team = {
      ...requiredNetworkValue(
        f.store.teams("event")[0] ?? {
          teamId: id(),
          eventId: f.eventA.eventId,
          internalSlug: "synthetic-team",
          displayName: "Synthetic",
          loginKey: "synthetic-participant-key",
          snapshot: null,
          score: 0,
          completedProblems: 0,
          scoreEvents: [],
        },
      ),
      eventId: f.eventA.eventId,
    };
    f.store.putTeam(team);
    for (const path of ["/portal/me", `/portal/me/problems/${f.problem.problemId}`]) {
      const response = await f.service.participant(
        apiRequest({ method: "GET", path, token: team.loginKey }),
      );
      expect(response.status).toBe(200);
      const body = JSON.stringify(response.body);
      expect(body).not.toContain(f.request.destination);
      expect(body).not.toContain("2606:4700:4700::1111");
      expect(body).not.toContain("internetAccess");
    }
    await expect(
      f.service.participant(
        apiRequest({
          method: "GET",
          path: `/events/${f.eventA.eventId}/internet-access`,
          token: team.loginKey,
        }),
      ),
    ).rejects.toThrow("Unknown participant endpoint.");
  } finally {
    await f.close();
  }
});

/* eslint-enable sonarjs/no-hardcoded-ip */

test("DELETE persists revocation even when event settlement refuses reconciliation", async () => {
  const f = await fixture();
  try {
    const suffix = `/${f.problem.problemId}`;
    expect(
      (await f.api(f.eventA.eventId, "PUT", { requestIds: ["upstream"] }, f.token, suffix)).status,
    ).toBe(200);
    Reflect.set(f.engine, "awaitEventSettled", async () => {
      throw new Error("Synthetic unconfirmed other-team halt.");
    });
    const response = await f.api(f.eventA.eventId, "DELETE", undefined, f.token, suffix);
    expect(f.grants.get(f.eventA.eventId, f.problem.problemId)).toBeUndefined();
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      message:
        "Internet access approval was revoked. Affected environments were halted. Error: Synthetic unconfirmed other-team halt.",
    });
    expect(f.grants.get(f.eventA.eventId, f.problem.problemId)).toBeUndefined();
  } finally {
    await f.close();
  }
});
