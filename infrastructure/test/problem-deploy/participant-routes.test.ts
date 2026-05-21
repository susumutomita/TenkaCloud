import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lookupTeamByLoginKey: vi.fn(),
  getParticipantDeployLogs: vi.fn(),
}));

vi.mock("../../lib/problem-deploy/handlers/participant-handler/shared", () => ({
  buildParticipantSharedResources: () => ({
    tableName: "TestDeployments",
    eventsTableName: "TestEvents",
    ddb: { send: vi.fn() },
  }),
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

const { app } = await import("../../lib/problem-deploy/handlers/participant-handler/index");

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
});
