import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";
import { getConsoleSigninUrl } from "../../lib/problem-deploy/handlers/participant-handler/sso";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

const JOB = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
const KEY = "TEAM_KEY";
const PREFIX = "tc-security-battle-royale-alpha";
const ACCOUNT = "999999999999";
const ROLE = `arn:aws:iam::${ACCOUNT}:role/${PREFIX}-participant-viewer`;
const STACK =
  "arn:aws:cloudformation:ap-northeast-1:999999999999:stack/tc-security-battle-royale-alpha/stack-id";
const row = (over: Record<string, unknown> = {}) => ({
  PK: `DEPLOYMENT#${JOB}`,
  SK: "META",
  jobId: JOB,
  teamLoginKey: KEY,
  problemId: "security-battle-royale",
  tenantId: "tenant-acme",
  region: "ap-northeast-1",
  namePrefix: PREFIX,
  awsAccountId: ACCOUNT,
  status: "COMPLETE",
  stackId: STACK,
  competitorRoleArn: `arn:aws:iam::${ACCOUNT}:role/TenkaCloud-CompetitorDeploy-Role`,
  stackOutputs: JSON.stringify({ ParticipantViewerRoleArn: ROLE }),
  expiresAt: Math.floor(Date.now() / 1000) + 7200,
  ...over,
});
const eventRow = (over: Record<string, unknown> = {}) => ({
  eventId: "event-one",
  tenantId: "tenant-acme",
  status: "READY",
  problems: [{ problemId: "security-battle-royale", defaultRegion: "ap-northeast-1" }],
  startsAt: new Date(Date.now() - 60_000).toISOString(),
  endsAt: new Date(Date.now() + 1800_000).toISOString(),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  ...over,
});
function fixture(deployment = row(), event = eventRow()) {
  const ddbSend = vi.fn(async (command: GetCommand) => ({
    Item: command.input.TableName === "Events" ? event : deployment,
  }));
  const ssmSend = vi
    .fn()
    .mockResolvedValue({ Parameter: { Type: "SecureString", Value: "tenant-external-id" } });
  const shared: ParticipantSharedResources = {
    runtime: makeTestControlDataRuntime(),
    tableName: "Deployments",
    eventsTableName: "Events",
    endpointsTableName: "",
    ddb: { send: ddbSend } as unknown as ParticipantSharedResources["ddb"],
    ssm: { send: ssmSend } as unknown as ParticipantSharedResources["ssm"],
    env: "development",
    problemsScoring: {},
    problemsEndpoints: {},
  };
  const stsSend = vi.fn().mockResolvedValue({
    Credentials: {
      AccessKeyId: "ASIA_VIEWER",
      SecretAccessKey: "VIEWER_SECRET",
      SessionToken: "VIEWER_TOKEN",
      Expiration: new Date(Date.now() + 3600_000),
    },
  });
  const verificationSend = vi.fn().mockResolvedValue({
    Credentials: {
      AccessKeyId: "ASIA_PROOF",
      SecretAccessKey: "PROOF_SECRET",
      SessionToken: "PROOF_TOKEN",
      Expiration: new Date(Date.now() + 900_000),
    },
  });
  const cfnSend = vi.fn().mockResolvedValue({
    StackResourceDetail: {
      StackId: STACK,
      LogicalResourceId: "ParticipantViewerRole",
      ResourceType: "AWS::IAM::Role",
      ResourceStatus: "CREATE_COMPLETE",
      PhysicalResourceId: ROLE.split("/").at(-1),
    },
  });
  const buildVerificationClient = vi.fn().mockReturnValue({ send: cfnSend });
  const fetchClient = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ SigninToken: "TOKEN" })));
  const deps = {
    sts: { send: stsSend },
    verificationSts: { send: verificationSend },
    buildVerificationClient,
    fetchClient: fetchClient as unknown as typeof fetch,
  };
  return {
    shared,
    verificationSend,
    cfnSend,
    buildVerificationClient,
    ddbSend,
    ssmSend,
    stsSend,
    fetchClient,
    deps,
    issue: (job = JOB) => getConsoleSigninUrl(shared, KEY, job, deps),
  };
}
afterEach(() => vi.unstubAllEnvs());

describe("participant console SSO: direct operator viewer access", () => {
  it("uses the operator client once with exact owned output and mandatory job ExternalId", async () => {
    const f = fixture();
    const result = await f.issue();
    expect(result.kind).toBe("ok");
    expect(f.stsSend).toHaveBeenCalledTimes(1);
    const command = f.stsSend.mock.calls[0]?.[0] as AssumeRoleCommand;
    expect(command).toBeInstanceOf(AssumeRoleCommand);
    expect(command.input).toMatchObject({
      RoleArn: ROLE,
      ExternalId: JOB,
      RoleSessionName: `security-battle-royale-${JOB}`,
      DurationSeconds: 3600,
    });
    expect(f.ssmSend).toHaveBeenCalledOnce();
    expect(f.ddbSend).toHaveBeenCalledTimes(2);
    for (const [read] of f.ddbSend.mock.calls) {
      expect(read).toBeInstanceOf(GetCommand);
      expect(read.input).toMatchObject({
        Key: { PK: `DEPLOYMENT#${JOB}`, SK: "META" },
        ConsistentRead: true,
      });
    }
    const url = new URL(String(f.fetchClient.mock.calls[0]?.[0]));
    expect(url.searchParams.get("SessionDuration")).toBeNull();
    expect(JSON.parse(url.searchParams.get("Session") ?? "{}")).toEqual({
      sessionId: "ASIA_VIEWER",
      sessionKey: "VIEWER_SECRET",
      sessionToken: "VIEWER_TOKEN",
    });
    if (result.kind === "ok") {
      const login = new URL(result.loginUrl);
      expect(login.searchParams.get("SigninToken")).toBe("TOKEN");
      expect(login.searchParams.get("Destination")).toBe(
        "https://ap-northeast-1.console.aws.amazon.com/console/home?region=ap-northeast-1",
      );
    }
  });

  it.each([
    `${PREFIX}-ParticipantViewerRole-ABC123`,
    "tc-security-battle-ParticipantViewerRole-ABC123",
    "tc-very-long-stack-Participa-ABC123",
  ])(
    "accepts canonical generated viewer name %s, including truncated stack prefixes",
    async (name) => {
      const f = fixture(
        row({
          stackOutputs: JSON.stringify({
            ParticipantViewerRoleArn: `arn:aws:iam::${ACCOUNT}:role/${name}`,
          }),
        }),
      );
      f.cfnSend.mockResolvedValueOnce({
        StackResourceDetail: {
          StackId: STACK,
          LogicalResourceId: "ParticipantViewerRole",
          ResourceType: "AWS::IAM::Role",
          ResourceStatus: "CREATE_COMPLETE",
          PhysicalResourceId: name,
        },
      });
      expect((await f.issue()).kind).toBe("ok");
      expect(f.stsSend.mock.calls[0]?.[0].input.RoleArn).toBe(
        `arn:aws:iam::${ACCOUNT}:role/${name}`,
      );
    },
  );

  it("uses a separate read-only verification session for the exact stack", async () => {
    const f = fixture();
    expect((await f.issue()).kind).toBe("ok");
    const proof = f.verificationSend.mock.calls[0]?.[0] as AssumeRoleCommand;
    expect(proof.input).toMatchObject({
      RoleArn: `arn:aws:iam::${ACCOUNT}:role/TenkaCloud-CompetitorDeploy-Role`,
      ExternalId: "tenant-external-id",
      DurationSeconds: 900,
    });
    expect(JSON.parse(proof.input.Policy ?? "{}").Statement).toEqual([
      { Effect: "Allow", Action: "cloudformation:DescribeStackResource", Resource: STACK },
      { Effect: "Deny", NotAction: "cloudformation:DescribeStackResource", Resource: "*" },
      { Effect: "Deny", Action: "cloudformation:DescribeStackResource", NotResource: STACK },
    ]);
    expect(f.cfnSend.mock.calls[0]?.[0].input).toEqual({
      StackName: STACK,
      LogicalResourceId: "ParticipantViewerRole",
    });
    expect(f.buildVerificationClient).toHaveBeenCalledWith(
      {
        accessKeyId: "ASIA_PROOF",
        secretAccessKey: "PROOF_SECRET",
        sessionToken: "PROOF_TOKEN",
        expiration: expect.any(Date),
      },
      "ap-northeast-1",
    );
    expect(f.ssmSend.mock.calls[0]?.[0].input).toEqual({
      Name: "/development/tenants/tenant-acme/external-id",
      WithDecryption: true,
    });
    expect(f.stsSend).toHaveBeenCalledOnce();
    expect(f.stsSend.mock.calls[0]?.[0].input.ExternalId).toBe(JOB);
  });

  it.each([
    { StackId: `${STACK}-another` },
    { LogicalResourceId: "DeploymentRole" },
    { ResourceType: "AWS::SSM::Parameter" },
    { ResourceStatus: "DELETE_COMPLETE" },
    { PhysicalResourceId: "tc-another-team-viewer" },
    { PhysicalResourceId: undefined },
  ])("rejects an unproven viewer resource %j", async (over) => {
    const f = fixture();
    f.cfnSend.mockResolvedValueOnce({
      StackResourceDetail: {
        StackId: STACK,
        LogicalResourceId: "ParticipantViewerRole",
        ResourceType: "AWS::IAM::Role",
        ResourceStatus: "CREATE_COMPLETE",
        PhysicalResourceId: ROLE.split("/").at(-1),
        ...over,
      },
    });
    expect(await f.issue()).toEqual({ kind: "not_ready" });
    expect(f.stsSend).not.toHaveBeenCalled();
    expect(f.fetchClient).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { Type: "String", Value: "tenant-external-id" },
    { Type: "SecureString", Value: "" },
  ])("requires the tenant SecureString before any verification session", async (Parameter) => {
    const f = fixture();
    f.ssmSend.mockResolvedValueOnce({ Parameter });
    expect((await f.issue()).kind).toBe("assume_role_failed");
    expect(f.verificationSend).not.toHaveBeenCalled();
    expect(f.stsSend).not.toHaveBeenCalled();
  });

  it("rejects invalid job IDs before reading or issuing credentials", async () => {
    const f = fixture();
    expect(await f.issue("not-ulid")).toEqual({ kind: "invalid_jobid" });
    expect(f.ddbSend).not.toHaveBeenCalled();
    expect(f.stsSend).not.toHaveBeenCalled();
  });

  it.each([
    ["revoked bearer", { teamLoginKey: undefined }, "unauthorized"],
    ["another team", { teamLoginKey: "OTHER_KEY" }, "unauthorized"],
    ["composite target", { parentDeploymentId: "parent-job" }, "unauthorized"],
    ["another job", { jobId: "01HZX0K3M3K9ZQHB3MRQHBA1B3" }, "unauthorized"],
    ["deleted", { status: "DELETED" }, "unauthorized"],
    ["teardown requested", { teardownRequestedAt: "2026-01-01T00:00:00Z" }, "unauthorized"],
    ["expired", { expiresAt: 1 }, "unauthorized"],
    ["missing expiry", { expiresAt: undefined }, "unauthorized"],
    ["failed", { status: "FAILED" }, "not_ready"],
    ["pending", { status: "PENDING" }, "not_ready"],
    ["in progress", { status: "IN_PROGRESS" }, "not_ready"],
    ["missing stack identity", { stackId: undefined }, "not_ready"],
    ["another stack", { stackId: STACK.replace("alpha/", "other/") }, "not_ready"],
    ["another stack account", { stackId: STACK.replace(ACCOUNT, "888888888888") }, "not_ready"],
    [
      "another stack region",
      { stackId: STACK.replace("ap-northeast-1", "us-east-1") },
      "not_ready",
    ],
    ["missing name", { namePrefix: undefined }, "not_ready"],
    ["injected name", { namePrefix: "tc-evil#x" }, "not_ready"],
    ["injected region", { region: "evil-region; rm -rf" }, "not_ready"],
    ["missing tenant", { tenantId: undefined }, "not_ready"],
    ["missing problem", { problemId: undefined }, "not_ready"],
    ["malformed deploy role", { competitorRoleArn: "bad-arn" }, "not_ready"],
    ["mismatched account", { awsAccountId: "888888888888" }, "not_ready"],
    ["missing viewer output", { stackOutputs: "{}" }, "not_ready"],
  ])("rejects %s before AWS access", async (_name, over, kind) => {
    const f = fixture(row(over as Record<string, unknown>));
    expect(await f.issue()).toEqual({ kind });
    expect(f.stsSend).not.toHaveBeenCalled();
    expect(f.fetchClient).not.toHaveBeenCalled();
  });

  it.each([
    `arn:aws:iam::888888888888:role/${PREFIX}-participant-viewer`,
    `arn:aws:iam::${ACCOUNT}:role/TenkaCloud-CompetitorDeploy-Role`,
    `arn:aws:iam::${ACCOUNT}:role/OtherAdmin`,
    `arn:aws:iam::${ACCOUNT}:role/tc-other-team-participant-viewer`,
    `arn:aws:iam::${ACCOUNT}:role/tc-other-team-ParticipantViewerRole-ABC`,
    `arn:aws:iam::${ACCOUNT}:role/path/${PREFIX}-participant-viewer`,
  ])("rejects unowned or non-viewer output %s", async (arn) => {
    const f = fixture(row({ stackOutputs: JSON.stringify({ ParticipantViewerRoleArn: arn }) }));
    expect(await f.issue()).toEqual({ kind: "not_ready" });
    expect(f.stsSend).not.toHaveBeenCalled();
  });

  it("rejects the operator's own account", async () => {
    vi.stubEnv("PARTICIPANT_OPERATOR_ACCOUNT_ID", ACCOUNT);
    const f = fixture();
    expect(await f.issue()).toEqual({ kind: "not_ready" });
    expect(f.stsSend).not.toHaveBeenCalled();
  });

  it.each([
    { status: "ENDED" },
    { status: "TEARDOWN" },
    { status: "ARCHIVED" },
    { scoringLocked: true },
    { startsAt: undefined },
    { startsAt: "invalid" },
    { startsAt: new Date(Date.now() + 3600_000).toISOString() },
    { endsAt: new Date(Date.now() - 1000).toISOString() },
    { endsAt: "invalid" },
    { tenantId: "another-tenant" },
    { problems: [] },
  ])("rejects unavailable event %j", async (over) => {
    const f = fixture(row({ eventId: "event-one" }), eventRow(over));
    expect(await f.issue()).toEqual({ kind: "not_ready" });
    expect(f.stsSend).not.toHaveBeenCalled();
  });

  it("rejects an expired event before AWS access", async () => {
    const f = fixture(row({ eventId: "event-one" }), eventRow({ expiresAt: 1 }));
    expect(await f.issue()).toEqual({ kind: "unauthorized" });
    expect(f.stsSend).not.toHaveBeenCalled();
  });

  it("binds session use to the event end using an explicit deny", async () => {
    const event = eventRow();
    const f = fixture(row({ eventId: event.eventId }), event);
    expect((await f.issue()).kind).toBe("ok");
    const policy = JSON.parse(f.stsSend.mock.calls[0]?.[0].input.Policy);
    expect(policy.Statement).toContainEqual({
      Effect: "Deny",
      Action: "*",
      Resource: "*",
      Condition: { DateGreaterThanEquals: { "aws:CurrentTime": event.endsAt } },
    });
    expect(f.ddbSend.mock.calls.filter(([read]) => read.input.TableName === "Events")).toHaveLength(
      2,
    );
  });

  it.each([{ teamLoginKey: "ROTATED" }, { status: "DELETING" }, { expiresAt: 1 }])(
    "does not return a sign-in URL when access changes during federation: %j",
    async (change) => {
      const f = fixture();
      f.ddbSend.mockResolvedValueOnce({ Item: row() }).mockResolvedValueOnce({ Item: row(change) });
      expect((await f.issue()).kind).toBe("unauthorized");
      expect(f.stsSend).toHaveBeenCalledOnce();
    },
  );

  it("reports direct viewer AssumeRole failures without exposing error messages", async () => {
    const f = fixture();
    f.stsSend.mockRejectedValueOnce(
      Object.assign(new Error("sensitive ARN"), { name: "AccessDenied" }),
    );
    expect(await f.issue()).toEqual({
      kind: "assume_role_failed",
      stage: "participant_viewer",
      reason: "AccessDenied",
    });
    expect(f.fetchClient).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    {},
    { AccessKeyId: "A", SecretAccessKey: "S", SessionToken: "T" },
    { AccessKeyId: "A", SecretAccessKey: "S", SessionToken: "T", Expiration: new Date(0) },
  ])("rejects malformed or expired STS credentials", async (Credentials) => {
    const f = fixture();
    f.stsSend.mockResolvedValueOnce({ Credentials });
    expect((await f.issue()).kind).toBe("assume_role_failed");
    expect(f.fetchClient).not.toHaveBeenCalled();
  });

  it("returns federation endpoint failures", async () => {
    const f = fixture();
    f.fetchClient.mockResolvedValueOnce(new Response("failure", { status: 503 }));
    expect(await f.issue()).toEqual({ kind: "federation_endpoint_failed", status: 503 });
  });
  it.each(["not-json", "{}", '{"SigninToken":""}'])("rejects malformed token %s", async (body) => {
    const f = fixture();
    f.fetchClient.mockResolvedValueOnce(new Response(body));
    expect(await f.issue()).toEqual({ kind: "federation_token_malformed" });
  });
});
