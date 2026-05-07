import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lookupTeamByLoginKey: vi.fn(),
}));

vi.mock("../../lib/problem-deploy/handlers/participant-handler/shared", () => ({
  buildParticipantSharedResources: () => ({
    tableName: "TestDeployments",
    ddb: { send: vi.fn() },
  }),
}));

vi.mock("../../lib/problem-deploy/handlers/participant-handler/lookup", () => ({
  lookupTeamByLoginKey: mocks.lookupTeamByLoginKey,
}));

const { app } = await import("../../lib/problem-deploy/handlers/participant-handler/index");

const VALID_KEY = "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQ"; // 43 文字 base64url

describe("GET /portal/healthz", () => {
  it("ok: true を返すべき (auth 不要)", async () => {
    const res = await app.request("/portal/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

describe("GET /portal/me", () => {
  beforeEach(() => vi.clearAllMocks());

  it("正常系: lookup ヒットで 200 と team scope view を返すべき", async () => {
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
