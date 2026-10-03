import { Hono } from "hono";
import { SqlDeploymentsRepository } from "../../../lib/problem-deploy/control-data/sql-deployments-repository";
import { SqlEventsRepository } from "../../../lib/problem-deploy/control-data/sql-events-repository";
import { SqlTeamsRepository } from "../../../lib/problem-deploy/control-data/sql-teams-repository";
import { registerPublicRegistrationRoutes } from "../../../lib/problem-deploy/handlers/participant-handler/registration";
import type { ParticipantSharedResources } from "../../../lib/problem-deploy/handlers/participant-handler/shared";
import { configureRegistration } from "../../../lib/problem-deploy/handlers/shared/event-registration";
import { secureApiHeaders } from "../../../lib/problem-deploy/handlers/shared/secure-headers";
import { makeSqliteExecutor } from "../control-data/control-data-write.test-helpers";

export const fixtureTenantId = "registration-fixture";
export const fixtureEventId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export async function registrationHttpFixture() {
  const sql = makeSqliteExecutor();
  const events = new SqlEventsRepository(sql);
  const teams = new SqlTeamsRepository(sql);
  const deployments = new SqlDeploymentsRepository(sql);
  const at = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + 86400;
  await events.putEvent({
    eventId: fixtureEventId,
    tenantId: fixtureTenantId,
    name: "はじめての AWS Battle",
    status: "READY",
    problems: [{ problemId: "office-link-gate", defaultRegion: "ap-northeast-1" }],
    teamCount: 2,
    createdAt: at,
    updatedAt: at,
    expiresAt,
  });
  for (let i = 1; i <= 2; i++) {
    const teamId = `${fixtureEventId.slice(0, -1)}${i}`;
    const teamLoginKey = `${i}`.repeat(43);
    await teams.putTeam({
      tenantId: fixtureTenantId,
      eventId: fixtureEventId,
      teamId,
      teamLoginKey,
      awsAccountId: `${i}`.repeat(12),
      internalSlug: `team-${i}`,
      createdAt: at,
      updatedAt: at,
      expiresAt,
    });
    await deployments.putDeployment({
      tenantId: fixtureTenantId,
      eventId: fixtureEventId,
      teamId,
      teamLoginKey,
      jobId: `job-${i}`,
      problemId: "office-link-gate",
      awsAccountId: `${i}`.repeat(12),
      region: "ap-northeast-1",
      teamName: `team-${i}`,
      namePrefix: `team-${i}`,
      status: "IN_PROGRESS",
      createdAt: at,
      updatedAt: at,
      expiresAt,
    });
  }
  const deps = { events, teams, deployments };
  const opened = await configureRegistration(deps, fixtureTenantId, fixtureEventId, {
    enabled: true,
    teamIds: [1, 2].map((i) => `${fixtureEventId.slice(0, -1)}${i}`),
    closesAt: new Date(Date.now() + 3600000).toISOString(),
  });
  if (!("invitation" in opened) || !opened.invitation) throw new Error("fixture invite missing");
  const shared = {
    problemsScoring: {},
    ddb: {},
    eventsTableName: "",
    teamsTableName: "",
    tableName: "",
    runtime: {
      resolveRepositories: async () => ({ events, teams }),
      resolveEventsRepository: async () => events,
      resolveDeploymentsRepository: async () => deployments,
    },
  } as unknown as ParticipantSharedResources;
  const app = new Hono();
  app.use("*", secureApiHeaders());
  registerPublicRegistrationRoutes(app, shared);
  return { app, deps, shared, sql, invitation: opened.invitation };
}
