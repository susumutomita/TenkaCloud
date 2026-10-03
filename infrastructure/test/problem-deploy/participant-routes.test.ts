import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lookupTeamByLoginKey: vi.fn(),
  getParticipantDeployLogs: vi.fn(),
  bridgeCompositeConsoleSignin: vi.fn(),
  bridgeCompositeCliCredentials: vi.fn(),
}));

vi.mock("../../lib/problem-deploy/handlers/participant-handler/shared", () => ({
  buildParticipantSharedResources: () => ({
    tableName: "TestDeployments",
    eventsTableName: "TestEvents",
    ddb: { send: vi.fn() },
  }),
  // #2283: getJobPrerequisiteBlock (jobId 経路の Progression Gate guard) が team 行を引く。
  // 空 = 該当行なし → guard 素通し (= 各 route 本来の outcome を検証する既存テストを保つ)。
  queryTeamItems: vi.fn(async () => []),
}));

vi.mock("../../lib/problem-deploy/handlers/participant-handler/lookup", () => ({
  lookupTeamByLoginKey: mocks.lookupTeamByLoginKey,
}));

vi.mock("../../lib/problem-deploy/handlers/participant-handler/deploy-logs", () => ({
  defaultDeployLogDeps: {},
  getParticipantDeployLogs: mocks.getParticipantDeployLogs,
  parseDeployLogLimit: (raw: string | undefined) => {
    if (raw === undefined) return 50;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
  },
}));

vi.mock(
  "../../lib/problem-deploy/handlers/participant-handler/composite-aws-access-bridge",
  () => ({
    bridgeCompositeConsoleSignin: mocks.bridgeCompositeConsoleSignin,
    bridgeCompositeCliCredentials: mocks.bridgeCompositeCliCredentials,
  }),
);

const { app } = await import("../../lib/problem-deploy/handlers/participant-handler/index");

const VALID_PARENT_ID = "01HPARENTAAAAAAAAAAAAAAAAA";
const VALID_TARGET_ID = "01HTARGETXXXXXXXXXXXXXXXXX";
const compositeConsolePath = (parent: string, target: string) =>
  `/portal/me/composite/${parent}/targets/${target}/console-signin-url`;
const compositeCliPath = (parent: string, target: string) =>
  `/portal/me/composite/${parent}/targets/${target}/cli-credentials`;

const VALID_KEY = "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQ"; // 43 文字 base64url

describe("GET /portal/healthz", () => {
  it("should return ok: true (no auth required)", async () => {
    const res = await app.request("/portal/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

describe("GET /portal/me", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normal case: should return 200 with team-scope view on lookup hit", async () => {
    mocks.lookupTeamByLoginKey.mockResolvedValueOnce({
      team: { teamName: "Alpha", teamNameSetByCompetitor: false },
      problems: [
        {
          jobId: "JOB1",
          problemId: "p",
          region: "ap-northeast-1",
          status: "COMPLETE",
          stackOutputs: { FrontendUrl: "https://x" },
          expiresAt: 1_700_000_000,
          score: 0,
        },
      ],
    });
    const res = await app.request("/portal/me", {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.team.teamName).toBe("Alpha");
    expect(body.problems[0].jobId).toBe("JOB1");
    expect(body.problems[0].stackOutputs.FrontendUrl).toBe("https://x");
  });

  it("Authorization ヘッダ無しは 401 (lookup を呼ばない)", async () => {
    const res = await app.request("/portal/me");
    expect(res.status).toBe(401);
    expect(mocks.lookupTeamByLoginKey).not.toHaveBeenCalled();
  });

  it("Bearer プレフィックス無しは 401", async () => {
    const res = await app.request("/portal/me", {
      headers: { authorization: VALID_KEY },
    });
    expect(res.status).toBe(401);
    expect(mocks.lookupTeamByLoginKey).not.toHaveBeenCalled();
  });

  it("形式不正な key は 401 (DDB を叩かない — timing oracle 防止)", async () => {
    const res = await app.request("/portal/me", {
      headers: { authorization: "Bearer too-short" },
    });
    expect(res.status).toBe(401);
    expect(mocks.lookupTeamByLoginKey).not.toHaveBeenCalled();
  });

  it("lookup が undefined なら 401 (no_team_found)", async () => {
    mocks.lookupTeamByLoginKey.mockResolvedValueOnce(undefined);
    const res = await app.request("/portal/me", {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });
    expect(res.status).toBe(401);
  });

  it("lookup 例外は 500", async () => {
    mocks.lookupTeamByLoginKey.mockRejectedValueOnce(new Error("ddb down"));
    const res = await app.request("/portal/me", {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal_error");
  });
});

describe("GET /portal/me/deploy-logs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return 400 when jobId is missing", async () => {
    const res = await app.request("/portal/me/deploy-logs", {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });

    expect(res.status).toBe(400);
    expect(mocks.getParticipantDeployLogs).not.toHaveBeenCalled();
  });

  it("should return 400 when limit is invalid", async () => {
    const res = await app.request(
      "/portal/me/deploy-logs?jobId=01H8XGJWBWBAQ4N6RZHM4S2KMV&limit=101",
      { headers: { authorization: `Bearer ${VALID_KEY}` } },
    );

    expect(res.status).toBe(400);
    expect(mocks.getParticipantDeployLogs).not.toHaveBeenCalled();
  });

  it("normal case: should return deploy log response", async () => {
    mocks.getParticipantDeployLogs.mockResolvedValueOnce({
      kind: "ok",
      response: {
        jobId: "01H8XGJWBWBAQ4N6RZHM4S2KMV",
        buildStatus: "IN_PROGRESS",
        complete: false,
        nextToken: "next",
        entries: [
          { id: "1", timestamp: "2026-05-20T10:00:00.000Z", source: "codebuild", message: "hello" },
        ],
      },
    });

    const res = await app.request(
      "/portal/me/deploy-logs?jobId=01H8XGJWBWBAQ4N6RZHM4S2KMV&limit=10&nextToken=prev",
      { headers: { authorization: `Bearer ${VALID_KEY}` } },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries[0].message).toBe("hello");
    expect(mocks.getParticipantDeployLogs).toHaveBeenCalledWith(expect.anything(), {}, VALID_KEY, {
      jobId: "01H8XGJWBWBAQ4N6RZHM4S2KMV",
      nextToken: "prev",
      limit: 10,
    });
  });

  it("not_found outcome should return 404", async () => {
    mocks.getParticipantDeployLogs.mockResolvedValueOnce({ kind: "not_found" });

    const res = await app.request("/portal/me/deploy-logs?jobId=01H8XGJWBWBAQ4N6RZHM4S2KMV", {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });

    expect(res.status).toBe(404);
  });

  it("should return 400 validation_failed for non-ULID jobId (zod schema)", async () => {
    const res = await app.request("/portal/me/deploy-logs?jobId=not-a-ulid", {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
    expect(mocks.getParticipantDeployLogs).not.toHaveBeenCalled();
  });
});

describe("PATCH /portal/me (Issue #1242 zod body validation)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return 400 invalid_body for malformed JSON", async () => {
    const res = await app.request("/portal/me", {
      method: "PATCH",
      headers: { authorization: `Bearer ${VALID_KEY}`, "content-type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_body");
  });

  it("should return 400 validation_failed for missing teamName", async () => {
    const res = await app.request("/portal/me", {
      method: "PATCH",
      headers: { authorization: `Bearer ${VALID_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
  });

  it("should return 400 validation_failed for wrong-type teamName", async () => {
    const res = await app.request("/portal/me", {
      method: "PATCH",
      headers: { authorization: `Bearer ${VALID_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ teamName: 42 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
  });
});

describe("POST /portal/me/submit-flag (Issue #1242 zod body validation)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return 400 validation_failed for missing flag", async () => {
    const res = await app.request("/portal/me/submit-flag", {
      method: "POST",
      headers: { authorization: `Bearer ${VALID_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ problemId: "ddos-uptime" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
  });

  it("should return 400 validation_failed for non-regex problemId", async () => {
    const res = await app.request("/portal/me/submit-flag", {
      method: "POST",
      headers: { authorization: `Bearer ${VALID_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ problemId: "BadProblem", flag: "x" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
  });

  it("should return 400 invalid_body for malformed JSON", async () => {
    const res = await app.request("/portal/me/submit-flag", {
      method: "POST",
      headers: { authorization: `Bearer ${VALID_KEY}`, "content-type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_body");
  });
});

// [Composite Runtime / Issue #2077] Composite-target AWS access bridge routes.
describe("GET /portal/me/composite/:parent/targets/:target/console-signin-url", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should require a bearer token", async () => {
    const res = await app.request(compositeConsolePath(VALID_PARENT_ID, VALID_TARGET_ID));
    expect(res.status).toBe(401);
    expect(mocks.bridgeCompositeConsoleSignin).not.toHaveBeenCalled();
  });

  it("should return 400 validation_failed for a non-ULID target id", async () => {
    const res = await app.request(compositeConsolePath(VALID_PARENT_ID, "not-a-ulid"), {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
    // A malformed lookup key never reaches the bridge (no STS path).
    expect(mocks.bridgeCompositeConsoleSignin).not.toHaveBeenCalled();
  });

  it("should pass the bearer token as teamLoginKey and the path ids as the lookup key only", async () => {
    mocks.bridgeCompositeConsoleSignin.mockResolvedValueOnce({
      kind: "ok",
      loginUrl: "https://signin.aws.amazon.com/federation?Action=login",
    });
    const res = await app.request(compositeConsolePath(VALID_PARENT_ID, VALID_TARGET_ID), {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.loginUrl).toContain("Action=login");
    expect(mocks.bridgeCompositeConsoleSignin).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        teamLoginKey: VALID_KEY,
        parentDeploymentId: VALID_PARENT_ID,
        targetDeploymentId: VALID_TARGET_ID,
      },
    );
  });

  it("should return 409 capability_mismatch with the provider for a non-AWS target", async () => {
    mocks.bridgeCompositeConsoleSignin.mockResolvedValueOnce({
      kind: "capability_mismatch",
      provider: "gcp",
    });
    const res = await app.request(compositeConsolePath(VALID_PARENT_ID, VALID_TARGET_ID), {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("capability_mismatch");
    expect(body.provider).toBe("gcp");
  });

  it("should return 404 not_found for a cross-team or missing target", async () => {
    mocks.bridgeCompositeConsoleSignin.mockResolvedValueOnce({ kind: "not_found" });
    const res = await app.request(compositeConsolePath(VALID_PARENT_ID, VALID_TARGET_ID), {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });
    expect(res.status).toBe(404);
  });

  it("should return 400 not_ready for a non-complete target", async () => {
    mocks.bridgeCompositeConsoleSignin.mockResolvedValueOnce({ kind: "not_ready" });
    const res = await app.request(compositeConsolePath(VALID_PARENT_ID, VALID_TARGET_ID), {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /portal/me/composite/:parent/targets/:target/cli-credentials", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return the credentials view for a ready AWS target", async () => {
    mocks.bridgeCompositeCliCredentials.mockResolvedValueOnce({
      kind: "ok",
      credentials: {
        accessKeyId: "AKIAVIEWER",
        secretAccessKey: "S",
        sessionToken: "T",
        expiration: "2026-06-29T01:00:00.000Z",
        region: "ap-northeast-1",
        awsAccountId: "999999999999",
      },
    });
    const res = await app.request(compositeCliPath(VALID_PARENT_ID, VALID_TARGET_ID), {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credentials.accessKeyId).toBe("AKIAVIEWER");
    expect(mocks.bridgeCompositeCliCredentials).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        teamLoginKey: VALID_KEY,
        parentDeploymentId: VALID_PARENT_ID,
        targetDeploymentId: VALID_TARGET_ID,
      },
    );
  });

  it("should return 409 capability_mismatch for a non-AWS target", async () => {
    mocks.bridgeCompositeCliCredentials.mockResolvedValueOnce({
      kind: "capability_mismatch",
      provider: "azure",
    });
    const res = await app.request(compositeCliPath(VALID_PARENT_ID, VALID_TARGET_ID), {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("capability_mismatch");
    expect(body.provider).toBe("azure");
  });

  it("should return 404 not_found for a cross-team or missing target", async () => {
    mocks.bridgeCompositeCliCredentials.mockResolvedValueOnce({ kind: "not_found" });
    const res = await app.request(compositeCliPath(VALID_PARENT_ID, VALID_TARGET_ID), {
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });
    expect(res.status).toBe(404);
  });
});
