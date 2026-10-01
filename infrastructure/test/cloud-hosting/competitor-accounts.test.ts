import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompetitorAccountRecord } from "../../lib/problem-deploy/control-data/domain/competitor-accounts.js";
import { DeploymentConflict } from "../../lib/problem-deploy/control-data/domain/deployment-work.js";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../../lib/problem-deploy/control-data/domain/teams.js";
import {
  DynamoDbCompetitorAccountsRepository,
  registeredAccountGuard,
} from "../../lib/problem-deploy/control-data/dynamodb-competitor-accounts-repository.js";
import { DynamoDeploymentWork } from "../../lib/problem-deploy/control-data/dynamodb-deployment-work.js";
import { createCloudApp } from "../../lib/problem-deploy/handlers/cloud-api/app.js";
import { registerCloudCompetitorAccountRoutes } from "../../lib/problem-deploy/handlers/cloud-api/competitor-account-routes.js";
import { createRegisteredConnectionPreparer } from "../../lib/problem-deploy/handlers/cloud-api/connection-routes.js";
import { FakeRepository } from "./fake-repository.js";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const AT = new Date(NOW).toISOString();
const ROLE = "TenkaCloud-synthetic-installation-deploy-Role";
const AUTH = {
  issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example",
  audience: "client",
};
const clients: DynamoDBClient[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.destroy();
});
function account(overrides: Partial<CompetitorAccountRecord> = {}): CompetitorAccountRecord {
  return {
    awsAccountId: "123456789012",
    region: "us-east-1",
    competitorRoleName: ROLE,
    createdAt: AT,
    updatedAt: AT,
    createdBy: "organizer",
    registrationId: ulid(),
    revision: 1,
    verified: false,
    ...overrides,
  };
}
function row(record: CompetitorAccountRecord) {
  return { ...record, PK: "INSTALLATION#ACCOUNTS", SK: `ACCOUNT#${record.awsAccountId}` };
}
function failure(name = "ConditionalCheckFailedException") {
  return Object.assign(new Error("Synthetic failure"), { name });
}
function storage() {
  const client = new DynamoDBClient({
    region: "us-east-1",
    credentials: { accessKeyId: "DUMMYIDEXAMPLE", secretAccessKey: "DUMMYEXAMPLEKEY" },
  });
  clients.push(client);
  const send = vi
    .spyOn(DynamoDBDocumentClient.prototype, "send")
    .mockRejectedValue(new Error("Unexpected SDK call"));
  const accounts = new DynamoDbCompetitorAccountsRepository(DynamoDBDocumentClient.from(client), {
    events: "events",
    teams: "teams",
    deployments: "deployments",
  });
  return { accounts, send, document: DynamoDBDocumentClient.from(client) };
}
function connectionFixture() {
  const record = account({ verified: true, verifiedAt: AT });
  const event: EventRecord = {
    eventId: ulid(),
    name: "Synthetic",
    status: "READY",
    problems: [],
    teamCount: 1,
    createdAt: AT,
    updatedAt: AT,
    expiresAt: NOW / 1000 + 60,
  };
  const team: TeamRecord = {
    eventId: event.eventId,
    teamId: ulid(),
    internalSlug: "team",
    teamLoginKey: "A".repeat(43),
    authVersion: 1,
    accessRevoked: false,
    createdAt: AT,
    updatedAt: AT,
    expiresAt: event.expiresAt,
  };
  const connection = {
    eventId: event.eventId,
    teamId: team.teamId,
    accountId: record.awsAccountId,
    region: record.region,
    roleArn: `arn:aws:iam::${record.awsAccountId}:role/${ROLE}`,
    externalIdParameter: "arn:aws:ssm:us-east-1:210987654321:parameter/synthetic/external-id",
    bindingId: `account-${record.registrationId.toLowerCase()}`,
    registrationId: record.registrationId,
    version: 1,
    verifiedAt: AT,
    reviewedProblemIds: ["hello-world"],
  };
  const reference = {
    PK: `COMPETITOR#${record.awsAccountId}`,
    SK: `EVENT#${event.eventId}#TEAM#${team.teamId}`,
    awsAccountId: record.awsAccountId,
    eventId: event.eventId,
    teamId: team.teamId,
    registrationId: record.registrationId,
  };
  return { record, event, team, connection, reference, now: NOW };
}

describe("competitor registry storage with intercepted SDK commands (not Dynamo acceptance)", () => {
  it("conditionally registers unverified records and treats only definitive conditions as conflicts", async () => {
    const f = storage();
    const record = account();
    f.send.mockImplementationOnce(() => Promise.resolve({}));
    expect(await f.accounts.createAccount(record)).toBe("created");
    expect(f.send.mock.calls[0]?.[0]).toBeInstanceOf(TransactWriteCommand);
    expect(f.send.mock.calls[0]?.[0].input).toMatchObject({
      TransactItems: [
        {
          ConditionCheck: {
            Key: { PK: "INSTALLATION", SK: "CONTROL" },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        {
          ConditionCheck: {
            Key: { PK: "INSTALLATION#ACCOUNTS", SK: "EXTERNAL_ID" },
            ConditionExpression: "#state = :ready",
            ExpressionAttributeValues: { ":ready": "INITIALIZED" },
          },
        },
        {
          Put: {
            TableName: "events",
            Item: row(record),
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
      ],
    });
    f.send.mockRejectedValueOnce(failure());
    expect(await f.accounts.createAccount(record)).toBe("conflict");
    f.send.mockRejectedValueOnce(failure("AccessDeniedException"));
    await expect(f.accounts.createAccount(record)).rejects.toMatchObject({
      name: "AccessDeniedException",
    });
    await expect(f.accounts.createAccount({ ...record, verified: true })).rejects.toThrow(
      "unverified",
    );
  });
  it("paginates the installation partition strongly consistently and never uses a GSI", async () => {
    const f = storage();
    const first = account();
    const second = account({ awsAccountId: "222222222222" });
    const cursor = { PK: "INSTALLATION#ACCOUNTS", SK: "cursor" };
    f.send
      .mockImplementationOnce(() =>
        Promise.resolve({ Items: [row(first)], LastEvaluatedKey: cursor }),
      )
      .mockImplementationOnce(() => Promise.resolve({ Items: [row(second)] }));
    expect(await f.accounts.listAccounts()).toEqual([first, second]);
    expect(f.send.mock.calls[0]?.[0]).toBeInstanceOf(QueryCommand);
    for (const [command] of f.send.mock.calls)
      expect(command.input).toMatchObject({
        ConsistentRead: true,
        ExpressionAttributeValues: { ":pk": "INSTALLATION#ACCOUNTS", ":prefix": "ACCOUNT#" },
      });
    expect(f.send.mock.calls[1]?.[0].input).toMatchObject({ ExclusiveStartKey: cursor });
  });
  it("returns absent accounts but rejects malformed and cross-partition records", async () => {
    const f = storage();
    const record = account();
    f.send.mockImplementationOnce(() => Promise.resolve({}));
    expect(await f.accounts.getAccount(record.awsAccountId)).toBeUndefined();
    f.send.mockImplementationOnce(() =>
      Promise.resolve({ Item: { ...row(record), PK: "FOREIGN" } }),
    );
    await expect(f.accounts.getAccount(record.awsAccountId)).rejects.toThrow("scope mismatch");
    f.send.mockImplementationOnce(() =>
      Promise.resolve({ Item: row({ ...record, verified: true }) }),
    );
    await expect(f.accounts.getAccount(record.awsAccountId)).rejects.toThrow(
      "Missing competitor verification",
    );
    expect(f.send.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand);
    expect(f.send.mock.calls[0]?.[0].input).toMatchObject({ ConsistentRead: true });
    await expect(f.accounts.getAccount("bad")).rejects.toThrow();
  });
  it("fences stale verification against delete/recreate and removes verification on failure", async () => {
    const f = storage();
    const record = account();
    const verified = { ...record, verified: true, verifiedAt: AT, revision: 2 };
    f.send.mockImplementationOnce(() => Promise.resolve({ Attributes: row(verified) }));
    expect(await f.accounts.setVerified(record, true, AT)).toEqual(verified);
    const command = f.send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(UpdateCommand);
    expect(command?.input).toMatchObject({
      ConditionExpression: "registrationId = :registration AND revision = :revision",
      ExpressionAttributeValues: {
        ":registration": record.registrationId,
        ":revision": 1,
        ":next": 2,
      },
    });
    f.send.mockRejectedValueOnce(failure());
    expect(await f.accounts.setVerified(record, true, AT)).toBeUndefined();
    f.send.mockImplementationOnce(() =>
      Promise.resolve({ Attributes: row({ ...record, revision: 3 }) }),
    );
    await f.accounts.setVerified(verified, false, AT);
    expect(f.send.mock.calls[2]?.[0].input).toMatchObject({
      UpdateExpression: expect.stringContaining("REMOVE verifiedAt"),
    });
    f.send.mockImplementationOnce(() => Promise.resolve({}));
    await expect(f.accounts.setVerified(record, true, AT)).rejects.toThrow(
      "Missing competitor verification result",
    );
    f.send.mockRejectedValueOnce(failure("AccessDeniedException"));
    await expect(f.accounts.setVerified(record, true, AT)).rejects.toThrow();
  });
  it.each([
    undefined,
    { status: "READY" },
    { status: "TEARDOWN", teardownExpected: 1, teardownCompleted: 1 },
    { status: "ARCHIVED" },
    { status: "ARCHIVED", teardownExpected: 2, teardownCompleted: 1 },
    { status: "ARCHIVED", teardownExpected: -1, teardownCompleted: -1 },
  ])("blocks deletion while a referenced event is unresolved: %j", async (event) => {
    const f = storage();
    const source = connectionFixture();
    f.send
      .mockImplementationOnce(() => Promise.resolve({ Items: [source.reference] }))
      .mockImplementationOnce(() =>
        Promise.resolve(event ? { Item: { ...source.event, ...event } } : {}),
      );
    expect(await f.accounts.deleteAccount(source.record)).toBe("in_use");
    expect(f.send.mock.calls.some(([command]) => command instanceof DeleteCommand)).toBe(false);
  });
  it("deletes only after all strongly-read references are archived and fences a concurrent connection", async () => {
    const f = storage();
    const source = connectionFixture();
    const other = { ...source.reference, teamId: ulid() };
    other.SK = `EVENT#${other.eventId}#TEAM#${other.teamId}`;
    f.send
      .mockImplementationOnce(() => Promise.resolve({ Items: [source.reference, other] }))
      .mockImplementationOnce(() =>
        Promise.resolve({
          Item: { ...source.event, status: "ARCHIVED", teardownExpected: 1, teardownCompleted: 1 },
        }),
      )
      .mockRejectedValueOnce(failure());
    expect(await f.accounts.deleteAccount(source.record)).toBe("conflict");
    expect(f.send.mock.calls.filter(([command]) => command instanceof GetCommand)).toHaveLength(1);
    expect(f.send.mock.calls[2]?.[0].input).toMatchObject({
      ConditionExpression: "registrationId = :registration AND revision = :revision",
    });
    f.send
      .mockImplementationOnce(() => Promise.resolve({}))
      .mockImplementationOnce(() => Promise.resolve({}));
    expect(await f.accounts.deleteAccount(source.record)).toBe("deleted");
  });
  it("fails closed on corrupt references and SDK failures without silently removing the account", async () => {
    const f = storage();
    const source = connectionFixture();
    f.send.mockImplementationOnce(() =>
      Promise.resolve({
        Items: [{ ...source.reference, awsAccountId: "999999999999" }],
      }),
    );
    await expect(f.accounts.deleteAccount(source.record)).rejects.toThrow("scope mismatch");
    f.send
      .mockImplementationOnce(() => Promise.resolve({}))
      .mockRejectedValueOnce(failure("AccessDeniedException"));
    await expect(f.accounts.deleteAccount(source.record)).rejects.toThrow();
  });
  it("atomically links verification, event/team guards, deletion reference, and versioned connection", async () => {
    const f = storage();
    const source = connectionFixture();
    f.send.mockImplementationOnce(() => Promise.resolve({}));
    expect(await f.accounts.saveConnection(source)).toBe("saved");
    const command = f.send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    if (!(command instanceof TransactWriteCommand)) throw new Error("Expected transaction");
    expect(command.input.TransactItems).toHaveLength(6);
    expect(command.input.TransactItems?.[3]?.Update).toMatchObject({
      ConditionExpression:
        "registrationId = :registration AND revision = :revision AND verified = :yes",
      ExpressionAttributeValues: { ":next": 2 },
    });
    expect(command.input.TransactItems?.[4]?.Put?.Item).toEqual(source.reference);
    expect(command.input.TransactItems?.[5]?.Put).toMatchObject({
      ConditionExpression: "attribute_not_exists(PK)",
    });
    f.send.mockImplementationOnce(() => Promise.resolve({}));
    await f.accounts.saveConnection({
      ...source,
      previousVersion: 1,
      connection: { ...source.connection, version: 2 },
    });
    const second = f.send.mock.calls[1]?.[0];
    if (!(second instanceof TransactWriteCommand)) throw new Error("Expected transaction");
    expect(second.input.TransactItems?.[5]?.Put).toMatchObject({
      ConditionExpression: "version = :previous",
      ExpressionAttributeValues: { ":previous": 1 },
    });
    f.send.mockRejectedValueOnce(
      Object.assign(failure("TransactionCanceledException"), {
        CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }],
      }),
    );
    expect(await f.accounts.saveConnection(source)).toBe("conflict");
    f.send.mockRejectedValueOnce(failure("AccessDeniedException"));
    await expect(f.accounts.saveConnection(source)).rejects.toThrow();
  });
  it.each([
    "eventId",
    "teamId",
    "accountId",
    "region",
    "roleArn",
    "bindingId",
    "registrationId",
    "version",
  ])("rejects mismatched connection %s before sending", async (field) => {
    const f = storage();
    const source = connectionFixture();
    const other = field.endsWith("Id") ? ulid() : "other";
    await expect(
      f.accounts.saveConnection({
        ...source,
        connection: {
          ...source.connection,
          [field]: field === "version" ? 2 : other,
        },
      }),
    ).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });
});

function routeFixture() {
  const accounts = {
    listAccounts: vi.fn(async (): Promise<readonly CompetitorAccountRecord[]> => []),
    getAccount: vi.fn(
      async (_id: string): Promise<CompetitorAccountRecord | undefined> => undefined,
    ),
    createAccount: vi.fn(
      async (_record: CompetitorAccountRecord): Promise<"created" | "conflict"> => "created",
    ),
    setVerified: vi.fn(
      async (
        record: CompetitorAccountRecord,
        verified: boolean,
        at: string,
      ): Promise<CompetitorAccountRecord | undefined> => ({
        ...record,
        verified,
        verifiedAt: verified ? at : undefined,
        revision: record.revision + 1,
      }),
    ),
    deleteAccount: vi.fn(
      async (_record: CompetitorAccountRecord): Promise<"deleted" | "in_use" | "conflict"> =>
        "deleted",
    ),
  };
  const assertAccepting = vi.fn(async () => undefined);
  const ensureExternalId = vi.fn(async () => "SYNTHETIC-EXTERNAL-ID-ONLY");
  const verify = vi.fn(async (_record: CompetitorAccountRecord) => undefined);
  const app = createCloudApp({
    repository: new FakeRepository(),
    organizerAuth: AUTH,
    allowedOrigins: [],
    now: () => NOW,
  });
  registerCloudCompetitorAccountRoutes(app, {
    accounts,
    assertAccepting,
    ensureExternalId,
    verify,
    tenkaCloudAccountId: "210987654321",
    competitorRoleName: ROLE,
    defaultRegion: "us-east-1",
    organizerAuth: AUTH,
    now: () => NOW,
  });
  const request = (
    suffix: string,
    method = "GET",
    value?: unknown,
    role: string | null = "Admin",
  ) =>
    app.request(
      `/admin/competitor-accounts${suffix}`,
      {
        method,
        ...(value === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }),
      },
      {
        event: {
          requestContext: {
            authorizer: {
              claims: role
                ? {
                    sub: "organizer",
                    token_use: "id",
                    iss: AUTH.issuer,
                    aud: AUTH.audience,
                    exp: String(NOW / 1000 + 60),
                    "custom:userRole": role,
                  }
                : undefined,
            },
          },
        },
      },
    );
  return { accounts, assertAccepting, ensureExternalId, verify, request };
}
const INPUT = { awsAccountId: "123456789012", competitorRoleName: ROLE };
describe("existing competitor account HTTP contracts with injected storage/verifier", () => {
  it("rejects registration during installation drain before creating or exposing an ExternalId", async () => {
    const f = routeFixture();
    f.assertAccepting.mockRejectedValue(new DeploymentConflict("installation_draining"));
    expect((await f.request("", "POST", INPUT)).status).toBe(409);
    expect((await f.request("/bulk", "POST", { accounts: [INPUT] })).status).toBe(409);
    expect(f.ensureExternalId).not.toHaveBeenCalled();
    expect(f.accounts.createAccount).not.toHaveBeenCalled();
  });
  it("refuses the platform account in single, bulk and verify paths before role or secret access", async () => {
    const f = routeFixture();
    const self = { ...INPUT, awsAccountId: "210987654321" };
    expect((await f.request("", "POST", self)).status).toBe(400);
    const bulk = await f.request("/bulk", "POST", { accounts: [self] });
    expect(await bulk.json()).toMatchObject({ created: 0, invalid: 1 });
    f.accounts.getAccount.mockResolvedValue(account(self));
    expect((await f.request(`/${self.awsAccountId}/verify`, "POST", {})).status).toBe(409);
    expect(f.ensureExternalId).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.accounts.createAccount).not.toHaveBeenCalled();
  });
  it("returns the original create/list shapes without leaking registry identity or ExternalId through GET", async () => {
    const f = routeFixture();
    const response = await f.request("", "POST", INPUT);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      ...INPUT,
      verified: false,
      externalId: "SYNTHETIC-EXTERNAL-ID-ONLY",
      tenkaCloudAccountId: "210987654321",
    });
    const record = f.accounts.createAccount.mock.calls[0]?.[0];
    if (!record) throw new Error("Missing registration");
    expect(record.createdBy).toBe("organizer");
    f.accounts.listAccounts.mockResolvedValue([record]);
    const listed = await f.request("", "GET", undefined, "Viewer");
    const json = await listed.json();
    expect(json.items[0]).toMatchObject({ ...INPUT, verified: false });
    expect(JSON.stringify(json)).not.toMatch(/externalId|registrationId|revision|createdBy/u);
    expect(f.ensureExternalId).toHaveBeenCalledTimes(1);
  });
  it.each([null, "TenantAdmin", "", "Operator", "Viewer"])(
    "rejects mutations by %s before storage or secret access",
    async (role) => {
      const f = routeFixture();
      for (const [path, method, payload] of [
        ["", "POST", INPUT],
        ["/bulk", "POST", { accounts: [INPUT] }],
        [`/${INPUT.awsAccountId}/verify`, "POST", {}],
        [`/${INPUT.awsAccountId}`, "DELETE", undefined],
      ] as const) {
        expect((await f.request(path, method, payload, role)).status).toBe(role ? 403 : 401);
      }
      expect(f.accounts.getAccount).not.toHaveBeenCalled();
      expect(f.ensureExternalId).not.toHaveBeenCalled();
    },
  );
  it("rejects malformed, unsupported-role and duplicate registrations without revealing ExternalId", async () => {
    const f = routeFixture();
    for (const input of [
      { ...INPUT, tenantId: "foreign" },
      { ...INPUT, region: "cn-north-1" },
      { ...INPUT, competitorRoleName: "Administrator" },
      { awsAccountId: INPUT.awsAccountId },
    ])
      expect((await f.request("", "POST", input)).status).toBe(400);
    expect(f.ensureExternalId).not.toHaveBeenCalled();
    f.accounts.getAccount.mockResolvedValue(account());
    expect((await f.request("", "POST", INPUT)).status).toBe(409);
    expect(f.ensureExternalId).not.toHaveBeenCalled();
    f.accounts.getAccount.mockResolvedValue(undefined);
    f.accounts.createAccount.mockResolvedValue("conflict");
    const raced = await f.request("", "POST", INPUT);
    expect(raced.status).toBe(409);
    expect(await raced.text()).not.toContain("SYNTHETIC-EXTERNAL");
  });
  it("keeps partial bulk outcomes, only one secret lookup, and sanitized per-row failures", async () => {
    const f = routeFixture();
    f.accounts.getAccount
      .mockImplementationOnce(() => Promise.resolve(account()))
      .mockResolvedValue(undefined);
    f.accounts.createAccount
      .mockRejectedValueOnce(new Error("secret-bearing SDK failure"))
      .mockResolvedValue("created");
    const response = await f.request("/bulk", "POST", {
      defaults: { competitorRoleName: ROLE },
      accounts: [
        { awsAccountId: "111111111111" },
        { awsAccountId: "222222222222" },
        { awsAccountId: "333333333333" },
        { awsAccountId: "333333333333" },
        { awsAccountId: "444444444444", competitorRoleName: "Other" },
      ],
    });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({
      created: 1,
      duplicate: 1,
      invalid: 2,
      failed: 1,
      externalId: "SYNTHETIC-EXTERNAL-ID-ONLY",
    });
    expect(JSON.stringify(json)).not.toContain("secret-bearing");
    expect(f.ensureExternalId).toHaveBeenCalledTimes(1);
  });
  it("does not expose a secret if bulk creates nothing and rejects oversized requests", async () => {
    const f = routeFixture();
    f.accounts.getAccount.mockResolvedValue(account());
    const response = await f.request("/bulk", "POST", {
      accounts: [INPUT, { awsAccountId: "222222222222" }],
    });
    expect(await response.json()).toMatchObject({ created: 0, duplicate: 1, invalid: 1 });
    expect(f.ensureExternalId).not.toHaveBeenCalled();
    expect(
      (await f.request("/bulk", "POST", { accounts: Array.from({ length: 51 }, () => INPUT) }))
        .status,
    ).toBe(400);
  });
  it("verifies only the observed registration and rejects a stale result", async () => {
    const f = routeFixture();
    const record = account();
    f.accounts.getAccount.mockResolvedValue(record);
    const response = await f.request(`/${record.awsAccountId}/verify`, "POST", {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ verified: true, verifiedAt: AT });
    expect(f.verify).toHaveBeenCalledWith(record);
    expect(f.accounts.setVerified).toHaveBeenCalledWith(record, true, AT);
    f.accounts.setVerified.mockResolvedValue(undefined);
    expect((await f.request(`/${record.awsAccountId}/verify`, "POST", {})).status).toBe(409);
  });
  it("revokes a previous verification on STS failure without returning credentials or retrying old ExternalIds", async () => {
    const f = routeFixture();
    const record = account({ verified: true, verifiedAt: AT });
    f.accounts.getAccount.mockResolvedValue(record);
    f.verify.mockRejectedValue(new Error("SYNTHETIC-SECRET-RAW-ERROR"));
    const response = await f.request(`/${record.awsAccountId}/verify`, "POST", {});
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"competitor_verification_failed"}');
    expect(f.accounts.setVerified).toHaveBeenCalledWith(record, false, AT);
    expect(f.verify).toHaveBeenCalledTimes(1);
    f.accounts.setVerified.mockResolvedValue(undefined);
    expect((await f.request(`/${record.awsAccountId}/verify`, "POST", {})).status).toBe(409);
  });
  it("preserves DELETE 204 but blocks active resource references and keeps the ExternalId untouched", async () => {
    const f = routeFixture();
    const record = account();
    f.accounts.getAccount.mockResolvedValue(record);
    f.accounts.deleteAccount
      .mockImplementationOnce(() => Promise.resolve("in_use"))
      .mockImplementationOnce(() => Promise.resolve("conflict"))
      .mockImplementationOnce(() => Promise.resolve("deleted"));
    expect((await f.request(`/${record.awsAccountId}`, "DELETE")).status).toBe(409);
    expect((await f.request(`/${record.awsAccountId}`, "DELETE")).status).toBe(409);
    expect((await f.request(`/${record.awsAccountId}`, "DELETE")).status).toBe(204);
    expect(f.ensureExternalId).not.toHaveBeenCalled();
    f.accounts.getAccount.mockResolvedValue(undefined);
    expect((await f.request(`/${record.awsAccountId}`, "DELETE")).status).toBe(404);
  });
});

describe("registry connection composition and atomic authorization guard", () => {
  function prepared() {
    const f = storage();
    const source = connectionFixture();
    const work = new DynamoDeploymentWork(f.document, {
      events: "events",
      teams: "teams",
      deployments: "deployments",
    });
    const get = vi.spyOn(f.accounts, "getAccount").mockResolvedValue(source.record);
    const save = vi.spyOn(f.accounts, "saveConnection").mockResolvedValue("saved");
    const getConnection = vi.spyOn(work, "getConnection").mockResolvedValue(undefined);
    const catalog = async () => ({
      "hello-world": {
        problemId: "hello-world",
        problemDir: "problems/challenges/hello-world",
        artifactDigest: "a".repeat(64),
        catalogKey: `catalogs/${"b".repeat(64)}.json`,
        scoring: {
          kind: "flag" as const,
          points: 100,
          wrongPenalty: 0,
          flagOutputKey: "ExpectedFlag",
        },
        parameters: {},
      },
    });
    const options = {
      accounts: f.accounts,
      work,
      config: { roleName: ROLE, externalIdParameterArn: source.connection.externalIdParameter },
      catalog,
      legacyBindings: [],
    };
    const prepare = createRegisteredConnectionPreparer(options);
    const team = {
      ...source.team,
      awsAccountId: source.record.awsAccountId,
      region: source.record.region,
    };
    return { ...f, ...source, team, get, save, getConnection, options, prepare };
  }
  it("prepares the existing form's selected account automatically without a binding-ID request", async () => {
    const f = prepared();
    await f.prepare(f.event, f.team, NOW);
    expect(f.save).toHaveBeenCalledWith(
      expect.objectContaining({
        record: f.record,
        event: f.event,
        team: f.team,
        connection: f.connection,
      }),
    );
    expect(f.send).not.toHaveBeenCalled();
  });
  it("uses one unambiguous event default and rejects ambiguous/missing targets", async () => {
    const f = prepared();
    const team = { ...f.team, awsAccountId: undefined, region: undefined };
    await f.prepare(
      {
        ...f.event,
        problems: [
          {
            problemId: "hello-world",
            defaultAwsAccountId: f.record.awsAccountId,
            defaultRegion: f.record.region,
          },
        ],
      },
      team,
      NOW,
    );
    await expect(f.prepare(f.event, team, NOW)).rejects.toMatchObject({
      code: "connection_target_mismatch",
    });
    await expect(
      f.prepare(
        {
          ...f.event,
          problems: [
            {
              problemId: "a",
              defaultAwsAccountId: f.record.awsAccountId,
              defaultRegion: "us-east-1",
            },
            { problemId: "b", defaultAwsAccountId: "222222222222", defaultRegion: "eu-west-1" },
          ],
        },
        team,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "connection_target_mismatch" });
  });
  it("requires current verification and the selected region", async () => {
    const f = prepared();
    for (const record of [
      undefined,
      { ...f.record, verified: false },
      { ...f.record, region: "eu-west-1" },
    ]) {
      f.get.mockResolvedValue(record);
      await expect(f.prepare(f.event, f.team, NOW)).rejects.toMatchObject({
        code: "unverified_competitor_account",
      });
    }
    expect(f.save).not.toHaveBeenCalled();
  });
  it("reuses identical current registration but never overwrites changed registration identity", async () => {
    const f = prepared();
    f.getConnection.mockResolvedValue(f.connection);
    await f.prepare(f.event, f.team, NOW);
    expect(f.save).not.toHaveBeenCalled();
    f.get.mockResolvedValue({ ...f.record, registrationId: ulid() });
    await expect(f.prepare(f.event, f.team, NOW)).rejects.toMatchObject({
      code: "connection_registration_changed",
    });
  });
  it("converges a concurrent connection winner and bounds retry conflicts", async () => {
    const f = prepared();
    f.save.mockResolvedValue("conflict");
    f.getConnection.mockResolvedValueOnce(undefined).mockResolvedValueOnce(f.connection);
    await f.prepare(f.event, f.team, NOW);
    expect(f.save).toHaveBeenCalledTimes(1);
    f.getConnection.mockResolvedValue(undefined);
    await expect(f.prepare(f.event, f.team, NOW)).rejects.toMatchObject({
      code: "competitor_account_changed",
    });
    expect(f.save).toHaveBeenCalledTimes(9);
  });
  it("retains an already persisted legacy connection only while its exact binding stays configured", async () => {
    const f = prepared();
    const connection = { ...f.connection, bindingId: "account-legacy", registrationId: undefined };
    f.getConnection.mockResolvedValue(connection);
    await expect(f.prepare(f.event, f.team, NOW)).rejects.toMatchObject({
      code: "connection_registration_changed",
    });
    const binding = {
      id: "account-legacy",
      accountId: connection.accountId,
      region: connection.region,
      roleArn: connection.roleArn,
      externalIdParameterArn: connection.externalIdParameter,
      reviewedProblemIds: ["hello-world"],
    };
    await createRegisteredConnectionPreparer({ ...f.options, legacyBindings: [binding] })(
      f.event,
      f.team,
      NOW,
    );
    expect(f.get).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });
  it("returns an exact current account CAS guard for registry jobs and no registry bypass for malformed IDs", async () => {
    const f = storage();
    const source = connectionFixture();
    const tables = { events: "events", teams: "teams", deployments: "deployments" };
    f.send.mockImplementationOnce(() => Promise.resolve({ Item: row(source.record) }));
    expect(await registeredAccountGuard(f.document, tables, source.connection)).toMatchObject({
      ConditionCheck: {
        Key: { PK: "INSTALLATION#ACCOUNTS", SK: `ACCOUNT#${source.record.awsAccountId}` },
        ConditionExpression:
          "registrationId = :registration AND revision = :revision AND verified = :yes",
        ExpressionAttributeValues: {
          ":registration": source.record.registrationId,
          ":revision": 1,
          ":yes": true,
        },
      },
    });
    for (const record of [
      undefined,
      { ...source.record, verified: false },
      { ...source.record, registrationId: ulid() },
      { ...source.record, region: "eu-west-1" },
      { ...source.record, competitorRoleName: "Other" },
    ]) {
      f.send.mockImplementationOnce(() => Promise.resolve(record ? { Item: row(record) } : {}));
      await expect(
        registeredAccountGuard(f.document, tables, source.connection),
      ).rejects.toMatchObject({ code: "competitor_account_changed" });
    }
    expect(
      await registeredAccountGuard(f.document, tables, {
        ...source.connection,
        bindingId: "account-legacy",
        registrationId: undefined,
      }),
    ).toBeUndefined();
  });
});

describe("durable installation ExternalId initialization fence", () => {
  const parameter =
    "arn:aws:ssm:us-east-1:210987654321:parameter/tenkacloud/cloud/test-installation/external-id";
  it("reserves only an empty store after strongly consistent paginated reference checks", async () => {
    const f = storage();
    const cursor = { PK: "synthetic", SK: "page" };
    f.send
      .mockImplementationOnce(() => Promise.resolve({}))
      .mockImplementationOnce(() => Promise.resolve({ Items: [] }))
      .mockImplementationOnce(() => Promise.resolve({ Count: 0, LastEvaluatedKey: cursor }))
      .mockImplementationOnce(() => Promise.resolve({ Count: 0 }))
      .mockImplementationOnce(() => Promise.resolve({ Count: 0 }))
      .mockImplementationOnce(() => Promise.resolve({}));
    expect(await f.accounts.reserveExternalIdInitialization(parameter)).toBe(true);
    const scans = f.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof ScanCommand);
    expect(scans).toHaveLength(3);
    for (const scan of scans)
      expect(scan.input).toMatchObject({
        ConsistentRead: true,
        Select: "COUNT",
        ExpressionAttributeValues: { ":parameter": parameter, ":references": "COMPETITOR#" },
      });
    expect(scans[1]?.input.ExclusiveStartKey).toEqual(cursor);
    const transaction = f.send.mock.calls.at(-1)?.[0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction?.input).toMatchObject({
      TransactItems: [
        { ConditionCheck: { Key: { PK: "INSTALLATION", SK: "CONTROL" } } },
        {
          Put: {
            Item: {
              PK: "INSTALLATION#ACCOUNTS",
              SK: "EXTERNAL_ID",
              parameterArn: parameter,
              state: "INITIALIZING",
            },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
      ],
    });
  });
  it.each(["INITIALIZING", "INITIALIZED", "corrupt"])(
    "does not expire or replace an existing %s marker",
    async (state) => {
      const f = storage();
      f.send.mockImplementationOnce(() => Promise.resolve({ Item: { state } }));
      expect(await f.accounts.reserveExternalIdInitialization(parameter)).toBe(false);
      expect(f.send).toHaveBeenCalledTimes(1);
    },
  );
  it("blocks missing-key initialization when any existing account remains", async () => {
    const f = storage();
    f.send
      .mockImplementationOnce(() => Promise.resolve({}))
      .mockImplementationOnce(() => Promise.resolve({ Items: [row(account())] }));
    expect(await f.accounts.reserveExternalIdInitialization(parameter)).toBe(false);
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it.each(["event", "deployment"])(
    "blocks on %s references even without current account rows",
    async (kind) => {
      const f = storage();
      f.send
        .mockImplementationOnce(() => Promise.resolve({}))
        .mockImplementationOnce(() => Promise.resolve({ Items: [] }));
      if (kind === "deployment") f.send.mockImplementationOnce(() => Promise.resolve({ Count: 0 }));
      f.send.mockImplementationOnce(() => Promise.resolve({ Count: 1 }));
      expect(await f.accounts.reserveExternalIdInitialization(parameter)).toBe(false);
      expect(f.send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(
        false,
      );
    },
  );
  it("treats only a definitive reservation race as a retryable false outcome", async () => {
    const f = storage();
    const emptyReads = () =>
      f.send
        .mockImplementationOnce(() => Promise.resolve({}))
        .mockImplementationOnce(() => Promise.resolve({ Items: [] }))
        .mockImplementationOnce(() => Promise.resolve({ Count: 0 }))
        .mockImplementationOnce(() => Promise.resolve({ Count: 0 }));
    emptyReads().mockRejectedValueOnce(failure());
    expect(await f.accounts.reserveExternalIdInitialization(parameter)).toBe(false);
    emptyReads().mockRejectedValueOnce(failure("AccessDeniedException"));
    await expect(f.accounts.reserveExternalIdInitialization(parameter)).rejects.toMatchObject({
      name: "AccessDeniedException",
    });
  });
  it("requires an authoritative count and does not hide a partial/denied scan", async () => {
    const f = storage();
    f.send
      .mockImplementationOnce(() => Promise.resolve({}))
      .mockImplementationOnce(() => Promise.resolve({ Items: [] }))
      .mockImplementationOnce(() => Promise.resolve({}));
    await expect(f.accounts.reserveExternalIdInitialization(parameter)).rejects.toThrow();
    expect(f.send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(
      false,
    );
  });
  it("records only ARN/state, preserving existing namespace ownership and retaining history", async () => {
    const f = storage();
    f.send.mockImplementationOnce(() => Promise.resolve({}));
    await f.accounts.observeExternalId(parameter);
    const command = f.send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutCommand);
    expect(command?.input).toMatchObject({
      Item: {
        PK: "INSTALLATION#ACCOUNTS",
        SK: "EXTERNAL_ID",
        parameterArn: parameter,
        state: "INITIALIZED",
      },
      ConditionExpression: expect.stringContaining("parameterArn = :parameter"),
    });
    expect(JSON.stringify(command?.input)).not.toMatch(
      /secretValue|externalIdValue|SYNTHETIC-EXTERNAL-ID-ONLY/u,
    );
    f.send.mockRejectedValueOnce(failure());
    await expect(f.accounts.observeExternalId(`${parameter}-other`)).rejects.toThrow();
  });
});
