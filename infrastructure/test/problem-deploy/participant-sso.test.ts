import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";
import { getConsoleSigninUrl } from "../../lib/problem-deploy/handlers/participant-handler/sso";

const { stsSend } = vi.hoisted(() => ({ stsSend: vi.fn() }));

vi.mock("@aws-sdk/client-sts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-sts")>();
  return {
    ...actual,
    STSClient: class {
      send = stsSend;
    },
  };
});

const VALID_JOB_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
const TEAM_KEY = "KEY1";

function buildShared(): { shared: ParticipantSharedResources; ddbSend: ReturnType<typeof vi.fn> } {
  const ddbSend = vi.fn();
  const shared: ParticipantSharedResources = {
    tableName: "TestDeployments",
    eventsTableName: "TestEvents",
    ddb: { send: ddbSend } as unknown as ParticipantSharedResources["ddb"],
    problemsScoring: {},
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
  status: "COMPLETE",
  ...over,
});

describe("getConsoleSigninUrl", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const ORIGINAL_ENV = process.env.CONSOLE_VIEWER_ROLE_ARN;

  beforeEach(() => {
    process.env.CONSOLE_VIEWER_ROLE_ARN = "arn:aws:iam::123456789012:role/ConsoleViewerRole";
    stsSend.mockReset();
    fetchSpy.mockReset();
  });

  afterEach(() => {
    process.env.CONSOLE_VIEWER_ROLE_ARN = ORIGINAL_ENV;
  });

  it("不正な jobId (ULID 形式でない) は invalid_jobid を返すべき", async () => {
    const { shared } = buildShared();
    const result = await getConsoleSigninUrl(shared, TEAM_KEY, "not-ulid");
    expect(result).toEqual({ kind: "invalid_jobid" });
  });

  it("CONSOLE_VIEWER_ROLE_ARN env が無ければ role_arn_missing を返すべき (#705)", async () => {
    process.env.CONSOLE_VIEWER_ROLE_ARN = "";
    const { shared } = buildShared();
    const result = await getConsoleSigninUrl(shared, TEAM_KEY, VALID_JOB_ID);
    expect(result).toEqual({ kind: "role_arn_missing" });
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

    expect(stsSend).toHaveBeenCalledTimes(1);
    const sentCmd = stsSend.mock.calls[0]?.[0];
    expect(sentCmd).toBeInstanceOf(AssumeRoleCommand);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.loginUrl).toContain("https://signin.aws.amazon.com/federation");
    expect(result.loginUrl).toContain("Action=login");
    expect(result.loginUrl).toContain("SigninToken=SIGNIN_TOKEN_VALUE");
    expect(result.loginUrl).toContain("cloudformation");
    // 競技者の namePrefix で stacks フィルタを掛ける
    expect(result.loginUrl).toContain(encodeURIComponent("tc-security-battle-royale-alpha"));
  });

  it("AssumeRole に inline session policy を渡し、DDB / Secrets Manager / KMS / IAM を Deny で殺すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
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

    const cmd = stsSend.mock.calls[0]?.[0] as AssumeRoleCommand;
    const policyRaw = cmd.input.Policy;
    expect(typeof policyRaw).toBe("string");
    const policy = JSON.parse(policyRaw as string) as {
      Statement: Array<{ Effect: string; Action: string | string[]; Resource: string | string[] }>;
    };
    const flattenAction = (a: string | string[]) => (Array.isArray(a) ? a : [a]);
    const denyActions = policy.Statement.filter((s) => s.Effect === "Deny").flatMap((s) =>
      flattenAction(s.Action),
    );
    // 他チームの teamLoginKey が DDB Deployments に入っているので必須
    expect(denyActions).toContain("dynamodb:*");
    expect(denyActions).toContain("secretsmanager:*");
    expect(denyActions).toContain("kms:Decrypt");
    expect(denyActions).toContain("iam:*");
    // 連鎖 AssumeRole も封じる (= 別 Role に乗り換えられない)
    expect(denyActions).toContain("sts:AssumeRole");
    // #704: operator の deploy ジョブと tenant UserPool を遮蔽
    expect(denyActions).toContain("codepipeline:*");
    expect(denyActions).toContain("codebuild:*");
    expect(denyActions).toContain("cognito-idp:*");
    // CFn の閲覧は Allow されている
    const allowActions = policy.Statement.filter((s) => s.Effect === "Allow").flatMap((s) =>
      flattenAction(s.Action),
    );
    expect(allowActions).toContain("cloudformation:DescribeStacks");
  });

  it("#704: session policy の Allow Resource は deployment の namePrefix scope に絞られているべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
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

    const cmd = stsSend.mock.calls[0]?.[0] as AssumeRoleCommand;
    const policy = JSON.parse(cmd.input.Policy as string) as {
      Statement: Array<{ Effect: string; Action: string | string[]; Resource: string | string[] }>;
    };
    const flatten = (r: string | string[]) => (Array.isArray(r) ? r : [r]);
    const allowResources = policy.Statement.filter((s) => s.Effect === "Allow").flatMap((s) =>
      flatten(s.Resource),
    );
    // CFn / logs / lambda / s3 は namePrefix で絞られている (= 他チームの tc-* は AccessDenied)
    expect(
      allowResources.some(
        (r) => r === "arn:aws:cloudformation:*:*:stack/tc-security-battle-royale-alpha/*",
      ),
    ).toBe(true);
    expect(
      allowResources.some(
        (r) => r === "arn:aws:lambda:*:*:function:tc-security-battle-royale-alpha*",
      ),
    ).toBe(true);
    expect(allowResources.some((r) => r === "arn:aws:s3:::tc-security-battle-royale-alpha*")).toBe(
      true,
    );
  });

  it("getSigninToken が 5xx を返したら federation_endpoint_failed (#705)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
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
