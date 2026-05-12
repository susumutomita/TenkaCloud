import { StatusCodes } from "http-status-codes";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hono の dispatch path 通しの integration テスト (route → outcome → JSON)。
 * business logic (= endpoints.ts) は vi.mock で stub し、HTTP status / body 形だけ assert する。
 */

const mocks = vi.hoisted(() => ({
  listProblemEndpoints: vi.fn(),
  upsertProblemEndpointOverride: vi.fn(),
  deleteProblemEndpointOverride: vi.fn(),
}));

// `participant-handler/index.ts` が module load 時に `buildParticipantSharedResources()` を
// 呼ぶので、env を必要としない stub に差し替える。
vi.mock("../../lib/problem-deploy/handlers/participant-handler/shared", async () => {
  const actual = (await vi.importActual(
    "../../lib/problem-deploy/handlers/participant-handler/shared",
  )) as { queryTeamItems: unknown };
  return {
    ...actual,
    buildParticipantSharedResources: () => ({
      tableName: "Deployments",
      eventsTableName: "Events",
      endpointsTableName: "ProblemEndpoints",
      ddb: { send: vi.fn() },
      problemsScoring: {},
      problemsEndpoints: {},
    }),
  };
});

vi.mock("../../lib/problem-deploy/handlers/problem-endpoints-handler/endpoints", () => ({
  listProblemEndpoints: mocks.listProblemEndpoints,
  upsertProblemEndpointOverride: mocks.upsertProblemEndpointOverride,
  deleteProblemEndpointOverride: mocks.deleteProblemEndpointOverride,
}));

const { app } = await import("../../lib/problem-deploy/handlers/participant-handler/index");

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe("GET /portal/me/problems/:problemId/endpoints", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Authorization header が無いときは 401 を返すべき", async () => {
    const res = await app.request("/portal/me/problems/hello-world-battle/endpoints");
    expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
  });

  it("problemId が pattern と合わないときは 400 を返すべき", async () => {
    const res = await app.request("/portal/me/problems/INVALID_UPPER/endpoints", {
      headers: bearer("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(mocks.listProblemEndpoints).not.toHaveBeenCalled();
  });

  it("ok outcome は 200 と endpoints / teamId を返すべき", async () => {
    mocks.listProblemEndpoints.mockResolvedValueOnce({
      kind: "ok",
      teamId: "team-x",
      endpoints: [
        {
          slot: "frontend",
          overridable: true,
          defaultUrl: "https://front.example.com/",
          effectiveUrl: "https://front.example.com/",
        },
      ],
    });
    const res = await app.request("/portal/me/problems/hello-world-battle/endpoints", {
      headers: bearer("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    });
    expect(res.status).toBe(StatusCodes.OK);
    const body = (await res.json()) as { teamId: string; endpoints: unknown[] };
    expect(body.teamId).toBe("team-x");
    expect(body.endpoints).toHaveLength(1);
  });

  it("no_endpoints outcome は 404 を返すべき", async () => {
    mocks.listProblemEndpoints.mockResolvedValueOnce({ kind: "no_endpoints" });
    const res = await app.request("/portal/me/problems/hello-world/endpoints", {
      headers: bearer("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    });
    expect(res.status).toBe(StatusCodes.NOT_FOUND);
  });

  it("unauthorized outcome は 401 を返すべき", async () => {
    mocks.listProblemEndpoints.mockResolvedValueOnce({ kind: "unauthorized" });
    const res = await app.request("/portal/me/problems/hello-world/endpoints", {
      headers: bearer("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    });
    expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
  });
});

describe("POST /portal/me/problems/:problemId/endpoints/:slot", () => {
  beforeEach(() => vi.clearAllMocks());

  it("body が JSON でなければ 400 を返すべき", async () => {
    const res = await app.request("/portal/me/problems/hello-world-battle/endpoints/frontend", {
      method: "POST",
      headers: bearer("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      body: "not-json",
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(mocks.upsertProblemEndpointOverride).not.toHaveBeenCalled();
  });

  it("slot が pattern と合わないなら 400 を返すべき", async () => {
    const res = await app.request("/portal/me/problems/hello-world-battle/endpoints/UPPER_CASE", {
      method: "POST",
      headers: bearer("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      body: JSON.stringify({ url: "https://x.example.com/" }),
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
  });

  it("invalid_url outcome は 400 を返すべき", async () => {
    mocks.upsertProblemEndpointOverride.mockResolvedValueOnce({ kind: "invalid_url" });
    const res = await app.request("/portal/me/problems/hello-world-battle/endpoints/frontend", {
      method: "POST",
      headers: bearer("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      body: JSON.stringify({ url: "garbage" }),
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
  });

  it("slot_not_overridable outcome は 409 を返すべき", async () => {
    mocks.upsertProblemEndpointOverride.mockResolvedValueOnce({ kind: "slot_not_overridable" });
    const res = await app.request("/portal/me/problems/hello-world-battle/endpoints/frontend", {
      method: "POST",
      headers: bearer("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      body: JSON.stringify({ url: "https://x.example.com/" }),
    });
    expect(res.status).toBe(StatusCodes.CONFLICT);
  });

  it("ok outcome は 200 と更新後 view を返すべき", async () => {
    mocks.upsertProblemEndpointOverride.mockResolvedValueOnce({
      kind: "ok",
      teamId: "team-x",
      endpoints: [
        {
          slot: "frontend",
          overridable: true,
          defaultUrl: "https://default.example.com/",
          overrideUrl: "https://new.example.com/",
          effectiveUrl: "https://new.example.com/",
        },
      ],
    });
    const res = await app.request("/portal/me/problems/hello-world-battle/endpoints/frontend", {
      method: "POST",
      headers: bearer("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      body: JSON.stringify({ url: "https://new.example.com/" }),
    });
    expect(res.status).toBe(StatusCodes.OK);
    const body = (await res.json()) as { endpoints: { effectiveUrl: string }[] };
    expect(body.endpoints[0]?.effectiveUrl).toBe("https://new.example.com/");
  });
});

describe("DELETE /portal/me/problems/:problemId/endpoints/:slot", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ok outcome は 200 を返すべき", async () => {
    mocks.deleteProblemEndpointOverride.mockResolvedValueOnce({
      kind: "ok",
      teamId: "team-x",
      endpoints: [],
    });
    const res = await app.request("/portal/me/problems/hello-world-battle/endpoints/frontend", {
      method: "DELETE",
      headers: bearer("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    });
    expect(res.status).toBe(StatusCodes.OK);
  });

  it("unknown_slot outcome は 400 を返すべき", async () => {
    mocks.deleteProblemEndpointOverride.mockResolvedValueOnce({ kind: "unknown_slot" });
    const res = await app.request("/portal/me/problems/hello-world-battle/endpoints/frontend", {
      method: "DELETE",
      headers: bearer("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
  });
});
