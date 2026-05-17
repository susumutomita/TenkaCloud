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

  it("Issue #862: namePrefix が injection-pattern (= 特殊文字含) なら not_ready", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ namePrefix: "tc-abc#evil&injection" })],
    });
    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "not_ready" });
  });

  it("Issue #862: region が AWS region pattern に合わなければ not_ready", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ region: "evil-region; rm -rf" })],
    });
    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "not_ready" });
  });

  it("Issue #862: competitorRoleArn が IAM Role ARN 形式でなければ not_ready", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ competitorRoleArn: "not-an-arn-at-all" })],
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
      // Audit #8: session name に problemId を含める (= AWS Console 上部の federated user 表示で
      // 問題名が判別できるようにする、 image #30 の改善)。 `${problemId}-${jobId}` 形式。
      RoleSessionName: `security-battle-royale-${VALID_JOB_ID}`,
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

  it("STS AssumeRole が throw したら assume_role_failed + reason (error name) を返すべき (#705, #864)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    // Issue #864: reason は error.name (= 種別) のみを返す。 message / ARN は log に残さない。
    stsSend.mockRejectedValueOnce(
      Object.assign(new Error("role not assumable"), { name: "AccessDenied" }),
    );

    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result.kind).toBe("assume_role_failed");
    if (result.kind === "assume_role_failed") {
      expect(result.reason).toBe("AccessDenied");
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

/**
 * Issue #759: 各 not_ready 経路は structured log を 1 件 emit すべき。
 * CloudWatch Logs Insights `filter event like /^portal\.sso\.not_ready\./` で
 * どの gate で死んだか 1 引きで切り分け可能にする受入条件。
 */
describe("getConsoleSigninUrl: not_ready 経路の structured log (#759)", () => {
  const logSpy = vi.spyOn(console, "log");

  beforeEach(() => {
    stsSend.mockReset();
    ssmSend.mockReset();
    stsClientConfigs.length = 0;
    logSpy.mockReset();
    logSpy.mockImplementation(() => undefined);
  });

  afterEach(() => logSpy.mockReset());

  function findEvent(name: string): Record<string, unknown> | undefined {
    for (const call of logSpy.mock.calls) {
      const raw = call[0];
      if (typeof raw !== "string") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (parsed && typeof parsed === "object" && (parsed as { event?: unknown }).event === name) {
        return parsed as Record<string, unknown>;
      }
    }
    return undefined;
  }

  it("IN_PROGRESS の deployment で portal.sso.not_ready.in_progress を info log すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ status: "IN_PROGRESS" })] });
    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "not_ready" });
    const payload = findEvent("portal.sso.not_ready.in_progress");
    expect(payload).toBeDefined();
    expect(payload?.level).toBe("info");
    expect(payload?.jobId).toBe(VALID_JOB_ID);
    expect(payload?.problemId).toBe("security-battle-royale");
    expect(payload?.status).toBe("IN_PROGRESS");
  });

  it("namePrefix 未設定で portal.sso.not_ready.namePrefix_missing を info log すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ namePrefix: undefined, status: "COMPLETE" })],
    });
    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "not_ready" });
    const payload = findEvent("portal.sso.not_ready.namePrefix_missing");
    expect(payload).toBeDefined();
    expect(payload?.jobId).toBe(VALID_JOB_ID);
  });

  it("region 未設定で portal.sso.not_ready.region_missing を info log すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ region: undefined })],
    });
    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "not_ready" });
    const payload = findEvent("portal.sso.not_ready.region_missing");
    expect(payload).toBeDefined();
    expect(payload?.jobId).toBe(VALID_JOB_ID);
  });

  it("tenantId 未設定で portal.sso.not_ready.tenantId_missing を info log すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ tenantId: undefined })],
    });
    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "not_ready" });
    const payload = findEvent("portal.sso.not_ready.tenantId_missing");
    expect(payload).toBeDefined();
    expect(payload?.jobId).toBe(VALID_JOB_ID);
  });

  it("competitorRoleArn 未設定で portal.sso.not_ready.competitorRoleArn_missing を info log すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ competitorRoleArn: undefined })],
    });
    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "not_ready" });
    const payload = findEvent("portal.sso.not_ready.competitorRoleArn_missing");
    expect(payload).toBeDefined();
    expect(payload?.jobId).toBe(VALID_JOB_ID);
    expect(payload?.tenantId).toBe("tenant-acme");
  });

  it("ParticipantViewerRoleArn 不在で outputKeys を含む info log を emit すべき (世代不一致の即特定)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({
          stackOutputs: JSON.stringify({
            BaseUrl: "http://example.com",
            NamePrefix: "tc-foo-bar",
          }),
        }),
      ],
    });
    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "not_ready" });
    const payload = findEvent("portal.sso.not_ready.participantViewerRole_missing");
    expect(payload).toBeDefined();
    expect(payload?.jobId).toBe(VALID_JOB_ID);
    expect(payload?.outputKeys).toEqual(expect.arrayContaining(["BaseUrl", "NamePrefix"]));
    expect(payload?.outputKeys).not.toContain("ParticipantViewerRoleArn");
  });

  it("成功経路では not_ready log は 1 件も emit しないべき", async () => {
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
    const fetchSpy2 = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ SigninToken: "TOKEN" }), { status: 200 }),
      );
    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result.kind).toBe("ok");
    const notReadyEvents = logSpy.mock.calls.filter((c) => {
      const raw = c[0];
      if (typeof raw !== "string") return false;
      try {
        const parsed = JSON.parse(raw) as { event?: string };
        return typeof parsed.event === "string" && parsed.event.startsWith("portal.sso.not_ready.");
      } catch {
        return false;
      }
    });
    expect(notReadyEvents).toHaveLength(0);
    fetchSpy2.mockRestore();
  });
});
