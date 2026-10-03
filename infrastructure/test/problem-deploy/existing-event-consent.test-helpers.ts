import { Hono } from "hono";
import { vi } from "vitest";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events";
import { DynamoDbCompetitorAccountsRepository } from "../../lib/problem-deploy/control-data/dynamodb-competitor-accounts-repository";
import { DynamoDbDeploymentsRepository } from "../../lib/problem-deploy/control-data/dynamodb-deployments-repository";
import { DynamoDbEventsRepository } from "../../lib/problem-deploy/control-data/dynamodb-events-repository";
import { DynamoDbTeamsRepository } from "../../lib/problem-deploy/control-data/dynamodb-teams-repository";
import { SqlCompetitorAccountsRepository } from "../../lib/problem-deploy/control-data/sql-competitor-accounts-repository";
import { SqlDeploymentsRepository } from "../../lib/problem-deploy/control-data/sql-deployments-repository";
import { SqlEventsRepository } from "../../lib/problem-deploy/control-data/sql-events-repository";
import { SqlTeamsRepository } from "../../lib/problem-deploy/control-data/sql-teams-repository";
import { registerBulkDeployRoutes } from "../../lib/problem-deploy/handlers/event-handler/routes/bulk-deploy";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data/control-data-write.test-helpers";
import { buildShared } from "./event-bulk-deploy.test-helpers";

export const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
export const TEAM_ID = "team-one";
export const TENANT_ID = "tenant-a";
export const AT = "2026-10-03T12:00:00.000Z";
export const consent = {
  awsAccountId: "111111111111",
  riskVersion: "hosting-account-self-test-v1" as const,
};
export const acknowledgment = {
  ...consent,
  acknowledgedBy: "operator-one",
  acknowledgedAt: AT,
};
export function eventRecord(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    eventId: EVENT_ID,
    tenantId: TENANT_ID,
    name: "Already-created event",
    status: "DRAFT",
    problems: [
      {
        problemId: "hello-world",
        defaultAwsAccountId: consent.awsAccountId,
        defaultRegion: "ap-northeast-1",
      },
    ],
    teamCount: 1,
    createdAt: AT,
    updatedAt: AT,
    expiresAt: 4_102_444_800,
    ...overrides,
  };
}

/** Real domain repositories, with only the transport and AWS publisher replaced. */
export async function existingEventFixture(
  backend: "dynamodb" | "turso",
  overrides: Partial<EventRecord> = {},
) {
  const ddb = makeFakeDdb();
  const sql = makeSqliteExecutor();
  const events =
    backend === "dynamodb"
      ? new DynamoDbEventsRepository(ddb, "Events")
      : new SqlEventsRepository(sql);
  const teams =
    backend === "dynamodb"
      ? new DynamoDbTeamsRepository(ddb, "Teams")
      : new SqlTeamsRepository(sql);
  const deployments =
    backend === "dynamodb"
      ? new DynamoDbDeploymentsRepository(ddb, "Deployments")
      : new SqlDeploymentsRepository(sql);
  const accounts =
    backend === "dynamodb"
      ? new DynamoDbCompetitorAccountsRepository(ddb, "Accounts")
      : new SqlCompetitorAccountsRepository(sql);
  const { shared: base, eventsSend } = buildShared({ ddb });
  const repositories = await base.runtime.resolveRepositories({
    ddb,
    eventsTableName: "Events",
    teamsTableName: "Teams",
  });
  const shared = {
    ...base,
    runtime: {
      ...base.runtime,
      resolveRepositories: async () => ({ ...repositories, events, teams }),
      resolveEventsRepository: async () => events,
      resolveTeamsRepository: async () => teams,
      resolveDeploymentsRepository: async () => deployments,
      resolveCompetitorAccountsRepository: async () => accounts,
    },
  };
  await events.putEvent(eventRecord(overrides));
  await teams.putTeam({
    eventId: EVENT_ID,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    internalSlug: "alpha",
    awsAccountId: consent.awsAccountId,
    teamLoginKey: "existing-participant-key",
    createdAt: AT,
    updatedAt: AT,
    expiresAt: 4_102_444_800,
  });
  await accounts.createAccount({
    tenantId: TENANT_ID,
    awsAccountId: consent.awsAccountId,
    region: "ap-northeast-1",
    competitorRoleName: "RegisteredCompetitorRole",
    verified: true,
    createdBy: "operator-one",
    createdAt: AT,
    updatedAt: AT,
  });
  eventsSend.mockResolvedValue({});
  const save = vi.spyOn(events, "acknowledgeHostingAccountSelfTest");
  const writes = vi.spyOn(deployments, "createBulkDeployments");
  const app = new Hono();
  registerBulkDeployRoutes(app, shared);
  const deploy = (
    body?: unknown,
    tenantId = TENANT_ID,
    actor: string | undefined = "operator-one",
  ) =>
    app.request(
      `/events/${EVENT_ID}/deploy`,
      {
        method: "POST",
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      },
      {
        event: {
          requestContext: {
            authorizer: {
              jwt: {
                claims: {
                  ...(actor ? { sub: actor } : {}),
                  "custom:tenantId": tenantId,
                  "custom:userRole": "TenantAdmin",
                },
              },
            },
          },
        },
      },
    );
  return { shared, events, teams, deployments, accounts, eventsSend, save, writes, deploy };
}
