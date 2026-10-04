import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlDeploymentsRepository } from "../../../lib/problem-deploy/control-data/sql-deployments-repository";
import { SqlEventsRepository } from "../../../lib/problem-deploy/control-data/sql-events-repository";
import { SqlTeamsRepository } from "../../../lib/problem-deploy/control-data/sql-teams-repository";
import type { ParticipantSharedResources } from "../../../lib/problem-deploy/handlers/participant-handler/shared";
import { participantRateLimiter } from "../../../lib/problem-deploy/handlers/shared/rate-limiter";
import { makeSqliteExecutor } from "../control-data/control-data-write.test-helpers";
import {
  eventId,
  invitation,
  legacyEvent,
  receipt,
  teamId,
  teamLoginKey,
  tenantId,
} from "./legacy-fixture";

const state = vi.hoisted(() => {
  const participant: Partial<ParticipantSharedResources> = {};
  return { participant };
});
vi.mock("../../../lib/problem-deploy/handlers/participant-handler/shared", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  buildParticipantSharedResources: () => state.participant,
}));
vi.mock("../../../lib/problem-deploy/handlers/event-handler/shared", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  buildEventSharedResources: () => state.participant,
}));

const { app: participantApp } = await import(
  "../../../lib/problem-deploy/handlers/participant-handler/index"
);
const { app: eventApp } = await import("../../../lib/problem-deploy/handlers/event-handler/index");
let events: SqlEventsRepository;
let teams: SqlTeamsRepository;
let deployments: SqlDeploymentsRepository;
let storedEvent: ReturnType<typeof legacyEvent>;
let storedTeam: Awaited<ReturnType<SqlTeamsRepository["getTeam"]>>;
const resolveRepositories = vi.fn();
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  participantRateLimiter.reset();
  vi.clearAllMocks();
  vi.stubEnv("DEFAULT_TENANT_ID", tenantId);
  vi.stubEnv("DEFAULT_USER_ROLE", "TenantAdmin");
  vi.stubEnv("DEFAULT_TENANT_SUSPENDED", "false");
  const sql = makeSqliteExecutor();
  events = new SqlEventsRepository(sql);
  teams = new SqlTeamsRepository(sql);
  deployments = new SqlDeploymentsRepository(sql);
  storedEvent = legacyEvent();
  await events.putEvent(storedEvent);
  storedTeam = {
    tenantId,
    eventId,
    teamId,
    teamLoginKey,
    awsAccountId: "111111111111",
    internalSlug: "team-one",
    createdAt: storedEvent.createdAt,
    updatedAt: storedEvent.updatedAt,
    expiresAt: storedEvent.expiresAt,
  };
  await teams.putTeam(storedTeam);
  await deployments.putDeployment({
    ...storedTeam,
    jobId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
    problemId: "office-link-gate",
    region: "ap-northeast-1",
    teamName: storedTeam.internalSlug,
    namePrefix: storedTeam.internalSlug,
    status: "COMPLETE",
  });
  resolveRepositories.mockResolvedValue({ events, teams });
  Object.assign(state.participant, {
    ddb: {},
    tableName: "",
    eventsTableName: "",
    endpointsTableName: "",
    problemsScoring: {},
    problemsEndpoints: {},
    runtime: {
      resolveRepositories,
      resolveEventsRepository: async () => events,
      resolveDeploymentsRepository: async () => deployments,
    },
  });
});
afterEach(() => vi.unstubAllEnvs());

async function expectStoredDataUnchanged() {
  expect(await events.getEvent(tenantId, eventId)).toEqual(storedEvent);
  expect(await teams.getTeam(tenantId, eventId, teamId)).toEqual(storedTeam);
  expect(resolveRepositories).not.toHaveBeenCalled();
}

describe("retired cloud self-registration APIs", () => {
  it.each(["info", "claim", "status"])(
    "returns 404 for old %s requests without revealing credentials or reserving teams",
    async (action) => {
      const response = await participantApp.request(
        `/portal/registration/${tenantId}/${eventId}/${action}`,
        {
          method: "POST",
          headers: {
            ...auth(action === "status" ? receipt : invitation),
            "content-type": "application/json",
          },
          body: JSON.stringify({ receipt }),
        },
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.text()).toBe("404 Not Found");
      await expectStoredDataUnchanged();
    },
  );

  it.each(["TenantAdmin", "TenantOperator", "TenantViewer"])(
    "does not let %s read, reopen, or reissue old registration",
    async (role) => {
      vi.stubEnv("DEFAULT_USER_ROLE", role);
      for (const method of ["GET", "PUT"]) {
        const response = await eventApp.request(`/events/${eventId}/registration`, {
          method,
          headers: { "content-type": "application/json" },
          ...(method === "PUT"
            ? {
                body: JSON.stringify({
                  enabled: true,
                  teamIds: [teamId],
                  closesAt: storedEvent.registration?.closesAt,
                }),
              }
            : {}),
        });
        expect(response.status).toBe(404);
        expect(await response.text()).toBe("404 Not Found");
      }
      await expectStoredDataUnchanged();
    },
  );

  it("keeps the organizer role guard on removed event paths", async () => {
    vi.stubEnv("DEFAULT_USER_ROLE", "TenantUser");
    const response = await eventApp.request(`/events/${eventId}/registration`);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden_role" });
    await expectStoredDataUnchanged();
  });

  it("authenticates the distributed team login key while rejecting invites and receipts", async () => {
    for (const token of [undefined, invitation, receipt, "x".repeat(43)]) {
      const denied = await participantApp.request("/portal/me", {
        headers: token ? auth(token) : {},
      });
      expect(denied.status).toBe(401);
      expect(await denied.json()).toEqual({ error: "unauthorized" });
    }
    const response = await participantApp.request("/portal/me", { headers: auth(teamLoginKey) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.team).toMatchObject({ teamId, eventId, teamName: "team-one" });
    expect(body.problems).toHaveLength(1);
    expect(body.problems[0]).toMatchObject({ problemId: "office-link-gate", status: "COMPLETE" });
    const serialized = JSON.stringify(body);
    for (const secret of [
      teamLoginKey,
      invitation,
      receipt,
      storedEvent.registration?.invitationHash,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(body).not.toHaveProperty("registration");
    await expectStoredDataUnchanged();
  });
});
