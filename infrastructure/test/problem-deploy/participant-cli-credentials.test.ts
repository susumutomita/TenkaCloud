import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";
import { getCliCredentials } from "../../lib/problem-deploy/handlers/participant-handler/sso";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * Issue #1197: CLI / SDK 用一時資格情報。 Console federation と同じ 2 段 AssumeRole
 * (CompetitorDeployRole → ParticipantViewerRole) を実行し、 federation endpoint を
 * 呼ばずに credentials を返す。 IAM scope は Console と同じ (= ParticipantViewerRole)。
 */

const { stsSend, stsClientConfigs, ssmSend } = vi.hoisted(() => ({
  stsSend: vi.fn(),
  stsClientConfigs: [] as unknown[],
  ssmSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-sts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-sts")>();
  return {
    ...actual,
    STSClient: class {
      constructor(config?: unknown) {
        stsClientConfigs.push(config);
      }
      send = stsSend;
    },
  };
});

const VALID_JOB_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
const TEAM_KEY = "KEY1";

function buildShared(): { shared: ParticipantSharedResources; ddbSend: ReturnType<typeof vi.fn> } {
  const ddbSend = vi.fn();
  ssmSend.mockResolvedValue({ Parameter: { Value: "tenant-external-id-123456" } });
  const shared: ParticipantSharedResources = {
    runtime: makeTestControlDataRuntime(),
    tableName: "TestDeployments",
    eventsTableName: "TestEvents",
    endpointsTableName: "",
    ddb: { send: ddbSend } as unknown as ParticipantSharedResources["ddb"],
    ssm: { send: ssmSend } as unknown as ParticipantSharedResources["ssm"],
    env: "development",
    problemsScoring: {},
    problemsEndpoints: {},
  };
  return { shared, ddbSend };
}

const sampleRow = (over: Record<string, unknown> = {}) => ({
  PK: `DEPLOYMENT#${VALID_JOB_ID}`,
  SK: "META",
  GSI2PK: `TEAMKEY#${TEAM_KEY}`,
  jobId: VALID_JOB_ID,
  problemId: "security-battle-royale",
  region: "ap-northeast-1",
  awsAccountId: "999999999999",
  namePrefix: "tc-security-battle-royale-alpha",
  tenantId: "tenant-acme",
  competitorRoleArn: "arn:aws:iam::999999999999:role/TenkaCloud-CompetitorDeploy-Role",
  stackOutputs: JSON.stringify({
    ParticipantViewerRoleArn:
      "arn:aws:iam::999999999999:role/tc-security-battle-royale-alpha-participant-viewer",
  }),
  status: "COMPLETE",
  ...over,
});

describe("getCliCredentials", () => {
  beforeEach(() => {
    stsSend.mockReset();
    ssmSend.mockReset();
    stsClientConfigs.length = 0;
  });
  afterEach(() => {
    stsSend.mockReset();
    ssmSend.mockReset();
  });

  it("should return invalid_jobid when jobId is not in ULID form", async () => {
    const { shared } = buildShared();
    const result = await getCliCredentials(shared, TEAM_KEY, "not-ulid");
    expect(result).toEqual({ kind: "invalid_jobid" });
  });

  it("should return unauthorized when team has no matching deployments", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const result = await getCliCredentials(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "unauthorized" });
  });

  it("should return unauthorized when the deployment is DELETED", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ status: "DELETED" })] });
    const result = await getCliCredentials(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "unauthorized" });
  });

  it("should return not_ready for IN_PROGRESS deployments without AssumeRole", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ status: "IN_PROGRESS" })] });
    const result = await getCliCredentials(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "not_ready" });
    expect(stsSend).not.toHaveBeenCalled();
  });

  it("should return assume_role_failed with stage=competitor when 1st AssumeRole throws", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    stsSend.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    const result = await getCliCredentials(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result.kind).toBe("assume_role_failed");
    if (result.kind === "assume_role_failed") {
      expect(result.stage).toBe("competitor");
      expect(result.reason).toBe("AccessDenied");
    }
  });

  it("should return assume_role_failed with stage=participant_viewer when 2nd AssumeRole throws", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    stsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: "AKIADEPLOY",
        SecretAccessKey: "DEPLOYSECRET",
        SessionToken: "DEPLOYTOKEN",
        Expiration: new Date(),
      },
    });
    stsSend.mockRejectedValueOnce(
      Object.assign(new Error("participant viewer denied"), { name: "AccessDenied" }),
    );
    const result = await getCliCredentials(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result.kind).toBe("assume_role_failed");
    if (result.kind === "assume_role_failed") {
      expect(result.stage).toBe("participant_viewer");
    }
  });

  it("should return ok with credentials + region + awsAccountId for a healthy deployment", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    const expiration = new Date("2099-01-01T00:00:00Z");
    stsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: "AKIADEPLOY",
        SecretAccessKey: "DEPLOYSECRET",
        SessionToken: "DEPLOYTOKEN",
        Expiration: new Date(),
      },
    });
    stsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: "ASIAFAKE",
        SecretAccessKey: "SECRETFAKE",
        SessionToken: "TOKENFAKE",
        Expiration: expiration,
      },
    });

    const result = await getCliCredentials(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.credentials).toEqual({
      accessKeyId: "ASIAFAKE",
      secretAccessKey: "SECRETFAKE",
      sessionToken: "TOKENFAKE",
      expiration: expiration.toISOString(),
      region: "ap-northeast-1",
      awsAccountId: "999999999999",
    });
    expect(stsSend).toHaveBeenCalledTimes(2);
    // Federation endpoint は呼ばない (= console path との分岐確認)。
    expect(stsSend.mock.calls[1]?.[0]).toBeInstanceOf(AssumeRoleCommand);
  });

  it("should role-chain with same ExternalId semantics as console SSO (tenant ExternalId → jobId ExternalId)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    stsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: "AKIADEPLOY",
        SecretAccessKey: "DEPLOYSECRET",
        SessionToken: "DEPLOYTOKEN",
      },
    });
    stsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: "ASIAFAKE",
        SecretAccessKey: "SECRETFAKE",
        SessionToken: "TOKENFAKE",
      },
    });

    await getCliCredentials(shared, TEAM_KEY, VALID_JOB_ID);

    const first = stsSend.mock.calls[0]?.[0] as AssumeRoleCommand;
    expect(first.input).toMatchObject({
      RoleArn: "arn:aws:iam::999999999999:role/TenkaCloud-CompetitorDeploy-Role",
      ExternalId: "tenant-external-id-123456",
      DurationSeconds: 3600,
    });
    const second = stsSend.mock.calls[1]?.[0] as AssumeRoleCommand;
    expect(second.input).toMatchObject({
      RoleArn: "arn:aws:iam::999999999999:role/tc-security-battle-royale-alpha-participant-viewer",
      ExternalId: VALID_JOB_ID,
      DurationSeconds: 3600,
    });
  });
});
