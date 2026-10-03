import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { describe, expect, it, vi } from "vitest";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";
import { getCliCredentials } from "../../lib/problem-deploy/handlers/participant-handler/sso";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

const JOB = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
const KEY = "TEAM_KEY";
const ROLE = "arn:aws:iam::999999999999:role/tc-security-battle-royale-alpha-participant-viewer";
const STACK =
  "arn:aws:cloudformation:ap-northeast-1:999999999999:stack/tc-security-battle-royale-alpha/stack-id";
const row = (over: Record<string, unknown> = {}) => ({
  jobId: JOB,
  teamLoginKey: KEY,
  problemId: "security-battle-royale",
  tenantId: "tenant-acme",
  region: "ap-northeast-1",
  namePrefix: "tc-security-battle-royale-alpha",
  awsAccountId: "999999999999",
  status: "COMPLETE",
  stackId: STACK,
  competitorRoleArn: "arn:aws:iam::999999999999:role/TenkaCloud-CompetitorDeploy-Role",
  stackOutputs: JSON.stringify({ ParticipantViewerRoleArn: ROLE }),
  expiresAt: Math.floor(Date.now() / 1000) + 7200,
  ...over,
});
function fixture(deployment = row()) {
  const ddbSend = vi.fn().mockResolvedValue({ Item: deployment });
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
  const expiration = new Date(Date.now() + 3600_000);
  const stsSend = vi.fn().mockResolvedValue({
    Credentials: {
      AccessKeyId: "ASIA_VIEWER",
      SecretAccessKey: "VIEWER_SECRET",
      SessionToken: "VIEWER_TOKEN",
      Expiration: expiration,
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
  const fetchClient = vi.fn();
  return {
    ddbSend,
    verificationSend,
    cfnSend,
    buildVerificationClient,
    shared,
    expiration,
    stsSend,
    fetchClient,
    issue: (job = JOB) =>
      getCliCredentials(shared, KEY, job, {
        sts: { send: stsSend },
        verificationSts: { send: verificationSend },
        buildVerificationClient,
        fetchClient: fetchClient as unknown as typeof fetch,
      }),
  };
}

describe("participant CLI credentials", () => {
  it("returns only direct viewer credentials after separate read-only ownership verification", async () => {
    const f = fixture();
    expect(await f.issue()).toEqual({
      kind: "ok",
      credentials: {
        accessKeyId: "ASIA_VIEWER",
        secretAccessKey: "VIEWER_SECRET",
        sessionToken: "VIEWER_TOKEN",
        expiration: f.expiration.toISOString(),
        region: "ap-northeast-1",
        awsAccountId: "999999999999",
      },
    });
    expect(f.stsSend).toHaveBeenCalledOnce();
    expect(f.stsSend.mock.calls[0]?.[0]).toBeInstanceOf(AssumeRoleCommand);
    expect(f.stsSend.mock.calls[0]?.[0].input).toMatchObject({
      RoleArn: ROLE,
      ExternalId: JOB,
      DurationSeconds: 3600,
    });
    expect(f.fetchClient).not.toHaveBeenCalled();
  });
  it("does not fabricate a credential expiry", async () => {
    const f = fixture();
    f.stsSend.mockResolvedValueOnce({
      Credentials: { AccessKeyId: "A", SecretAccessKey: "S", SessionToken: "T" },
    });
    expect((await f.issue()).kind).toBe("assume_role_failed");
  });
  it("caps expiry and permissions at the deployment deadline", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const f = fixture(row({ expiresAt }));
    const result = await f.issue();
    expect(result.kind).toBe("ok");
    if (result.kind === "ok")
      expect(result.credentials.expiration).toBe(new Date(expiresAt * 1000).toISOString());
    const policy = JSON.parse(f.stsSend.mock.calls[0]?.[0].input.Policy);
    expect(policy.Statement[1].Condition.DateGreaterThanEquals["aws:CurrentTime"]).toBe(
      new Date(expiresAt * 1000).toISOString(),
    );
  });
  it.each([
    { teamLoginKey: undefined },
    { teamLoginKey: "OTHER" },
    { expiresAt: 1 },
    { status: "DELETED" },
  ])("rejects unauthorized deployment %j before STS", async (over) => {
    const f = fixture(row(over));
    expect(await f.issue()).toEqual({ kind: "unauthorized" });
    expect(f.stsSend).not.toHaveBeenCalled();
  });
  it("rejects invalid job IDs", async () => {
    const f = fixture();
    expect(await f.issue("invalid")).toEqual({ kind: "invalid_jobid" });
    expect(f.ddbSend).not.toHaveBeenCalled();
  });
  it("rejects unfinished deployments", async () => {
    const f = fixture(row({ status: "IN_PROGRESS" }));
    expect(await f.issue()).toEqual({ kind: "not_ready" });
    expect(f.stsSend).not.toHaveBeenCalled();
  });
  it("rechecks the current bearer after STS and withholds credentials after rotation", async () => {
    const f = fixture();
    f.ddbSend
      .mockResolvedValueOnce({ Item: row() })
      .mockResolvedValueOnce({ Item: row({ teamLoginKey: "ROTATED" }) });
    expect(await f.issue()).toEqual({ kind: "unauthorized" });
    expect(f.stsSend).toHaveBeenCalledOnce();
  });
  it("withholds credentials if the owned role changes during issuance", async () => {
    const f = fixture();
    f.ddbSend.mockResolvedValueOnce({ Item: row() }).mockResolvedValueOnce({
      Item: row({
        stackOutputs: JSON.stringify({
          ParticipantViewerRoleArn:
            "arn:aws:iam::999999999999:role/tc-security-battle-royale-ParticipantViewerRole-ABC",
        }),
      }),
    });
    expect(await f.issue()).toEqual({ kind: "not_ready" });
  });
  it("reports operator-to-viewer failures as participant_viewer", async () => {
    const f = fixture();
    f.stsSend.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    expect(await f.issue()).toEqual({
      kind: "assume_role_failed",
      stage: "participant_viewer",
      reason: "AccessDenied",
    });
  });
});
