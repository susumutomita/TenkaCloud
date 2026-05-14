import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";
import { getConsoleSigninUrl } from "../../lib/problem-deploy/handlers/participant-handler/sso";

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
    tableName: "TestDeployments",
    eventsTableName: "TestEvents",
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

describe("getConsoleSigninUrl", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  beforeEach(() => {
    stsSend.mockReset();
    ssmSend.mockReset();
    stsClientConfigs.length = 0;
    fetchSpy.mockReset();
  });

  afterEach(() => fetchSpy.mockReset());

  it("不正な jobId (ULID 形式でない) は invalid_jobid を返すべき", async () => {
    const { shared } = buildShared();
    const result = await getConsoleSigninUrl(shared, TEAM_KEY, "not-ulid");
    expect(result).toEqual({ kind: "invalid_jobid" });
  });

  it("teamLoginKey に該当 deployment が無ければ unauthorized を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "unauthorized" });
  });

  it("jobId が team の deployment 一覧に無ければ unauthorized を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ jobId: "01HZX0K3M3K9ZQHB3MRQHBA1B3" })] });
    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "unauthorized" });
  });

  it("DELETED な deployment には access させない (unauthorized)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ status: "DELETED" })] });
    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "unauthorized" });
  });

  it("IN_PROGRESS な deployment は AssumeRole せず not_ready を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ status: "IN_PROGRESS" })] });
    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "not_ready" });
    expect(stsSend).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("PENDING な deployment は AssumeRole せず not_ready を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ status: "PENDING" })] });
    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "not_ready" });
    expect(stsSend).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("namePrefix 未設定 (stack 未起動) は not_ready", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ namePrefix: undefined, status: "PENDING" })],
    });
    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "not_ready" });
  });

  it("正常系: STS AssumeRole + getSigninToken fetch を経由して signin login URL を返すべき", async () => {
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
    stsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: "AKIAFAKE",
        SecretAccessKey: "SECRETFAKE",
        SessionToken: "TOKENFAKE",
        Expiration: new Date(),
      },
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ SigninToken: "SIGNIN_TOKEN_VALUE" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);

    expect(stsSend).toHaveBeenCalledTimes(2);
    expect(stsSend.mock.calls[0]?.[0]).toBeInstanceOf(AssumeRoleCommand);
    expect(stsSend.mock.calls[1]?.[0]).toBeInstanceOf(AssumeRoleCommand);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.loginUrl).toContain("https://signin.aws.amazon.com/federation");
    expect(result.loginUrl).toContain("Action=login");
    expect(result.loginUrl).toContain("SigninToken=SIGNIN_TOKEN_VALUE");
    expect(result.loginUrl).toContain("cloudformation");
    // 競技者の namePrefix で stacks フィルタを掛ける
    expect(result.loginUrl).toContain(encodeURIComponent("tc-security-battle-royale-alpha"));

    // #747: getSigninToken request URL に SessionDuration param が含まれてはいけない
    // (AssumeRole 由来 credentials では federation endpoint が 400 を返すため)。
    const fetchedUrl = fetchSpy.mock.calls[0]?.[0]?.toString() ?? "";
    expect(fetchedUrl).toContain("Action=getSigninToken");
    expect(fetchedUrl).not.toContain("SessionDuration");
  });

  it("stackOutputs に ParticipantViewerRoleArn が無ければ not_ready を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ stackOutputs: JSON.stringify({}) })] });
    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "not_ready" });
    expect(stsSend).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("CompetitorDeployRole から ParticipantViewerRole へ role chaining するべき", async () => {
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
    stsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: "AKIAFAKE",
        SecretAccessKey: "SECRETFAKE",
        SessionToken: "TOKENFAKE",
        Expiration: new Date(),
      },
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ SigninToken: "TOKEN" }), { status: 200 }),
    );

    await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);

    const first = stsSend.mock.calls[0]?.[0] as AssumeRoleCommand;
    expect(first.input).toMatchObject({
      RoleArn: "arn:aws:iam::999999999999:role/TenkaCloud-CompetitorDeploy-Role",
      RoleSessionName: `participant-sso-${VALID_JOB_ID}`,
      ExternalId: "tenant-external-id-123456",
      DurationSeconds: 3600,
    });
    expect(first.input.Policy).toBeUndefined();

    const second = stsSend.mock.calls[1]?.[0] as AssumeRoleCommand;
    expect(second.input).toMatchObject({
      RoleArn: "arn:aws:iam::999999999999:role/tc-security-battle-royale-alpha-participant-viewer",
      RoleSessionName: `participant-viewer-${VALID_JOB_ID}`,
      ExternalId: VALID_JOB_ID,
      DurationSeconds: 3600,
    });
    expect(second.input.Policy).toBeUndefined();
    expect(stsClientConfigs).toContainEqual({
      credentials: {
        accessKeyId: "AKIADEPLOY",
        secretAccessKey: "DEPLOYSECRET",
        sessionToken: "DEPLOYTOKEN",
      },
    });
  });

  it("getSigninToken が 5xx を返したら federation_endpoint_failed (#705)", async () => {
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
    stsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: "AKIAFAKE",
        SecretAccessKey: "SECRETFAKE",
        SessionToken: "TOKENFAKE",
        Expiration: new Date(),
      },
    });
    fetchSpy.mockResolvedValueOnce(new Response("server error", { status: 500 }));

    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "federation_endpoint_failed", status: 500 });
  });

  it("STS AssumeRole が throw したら assume_role_failed + reason を返すべき (#705)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    stsSend.mockRejectedValueOnce(new Error("AccessDenied: role not assumable"));

    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result.kind).toBe("assume_role_failed");
    if (result.kind === "assume_role_failed") {
      expect(result.reason).toMatch(/AccessDenied/);
    }
  });

  it("STS Credentials が empty なら assume_role_failed を返すべき (#705)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    stsSend.mockResolvedValueOnce({ Credentials: undefined });

    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result.kind).toBe("assume_role_failed");
  });

  it("federation token JSON が malformed なら federation_token_malformed (#705)", async () => {
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
    stsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: "AKIAFAKE",
        SecretAccessKey: "SECRETFAKE",
        SessionToken: "TOKENFAKE",
        Expiration: new Date(),
      },
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ NotSigninToken: 123 }), { status: 200 }),
    );

    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "federation_token_malformed" });
  });
});
