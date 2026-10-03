import { StatusCodes } from "http-status-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1424: participant-handler の Hono app (index.ts) を route-wiring 層として pin する。
 * 既存の service 単体テスト群 (participant-cast-event / submit-flag / reveal-hint 等) は
 * service 関数を直接叩いており index.ts の route glue (withBearerAuth → schema parse →
 * outcome→HTTP) を通っていなかったため index.ts は 25% branch だった。
 *
 * 方針:
 *   - service module は全て mock (outcome を直接返す)。 const を持つ module は
 *     importOriginal で実値を残しつつ関数だけ差し替える。
 *   - route-helpers / schemas / rate-limiter は実物を使う (= 本物の validation・auth・
 *     in-memory token bucket を通す)。 rate limit に当たらないよう request 毎に unique token。
 */
const mocks = vi.hoisted(() => ({
  lookupTeamByLoginKey: vi.fn(),
  listScoreEvents: vi.fn(),
  getConsoleSigninUrl: vi.fn(),
  getCliCredentials: vi.fn(),
  listNotifications: vi.fn(),
  castEvent: vi.fn(),
  readInbox: vi.fn(),
  listBattleAttacks: vi.fn(),
  getParticipantDeployLogs: vi.fn(),
  getLeaderboard: vi.fn(),
  getLeaderboardScoreEvents: vi.fn(),
  setDisplayTeamName: vi.fn(),
  submitFlag: vi.fn(),
  revealHint: vi.fn(),
  listProblemEndpoints: vi.fn(),
  upsertProblemEndpointOverride: vi.fn(),
  deleteProblemEndpointOverride: vi.fn(),
}));

vi.mock("../../lib/problem-deploy/handlers/participant-handler/shared", () => ({
  buildParticipantSharedResources: () => ({ ddb: { send: vi.fn() }, problemsScoring: {} }),
  // #2283: getJobPrerequisiteBlock (jobId 経路の Progression Gate guard) が team 行を引く。
  // 空 = 該当行なし → guard 素通し (= 各 route 本来の outcome を検証する既存テストを保つ)。
  queryTeamItems: vi.fn(async () => []),
}));
vi.mock("../../lib/problem-deploy/handlers/participant-handler/lookup", () => ({
  lookupTeamByLoginKey: mocks.lookupTeamByLoginKey,
}));
vi.mock("../../lib/problem-deploy/handlers/participant-handler/score-events", () => ({
  listScoreEvents: mocks.listScoreEvents,
}));
vi.mock("../../lib/problem-deploy/handlers/participant-handler/sso", () => ({
  getConsoleSigninUrl: mocks.getConsoleSigninUrl,
  getCliCredentials: mocks.getCliCredentials,
}));
vi.mock("../../lib/problem-deploy/handlers/participant-handler/leaderboard", () => ({
  getLeaderboard: mocks.getLeaderboard,
}));
vi.mock("../../lib/problem-deploy/handlers/participant-handler/leaderboard-score-events", () => ({
  getLeaderboardScoreEvents: mocks.getLeaderboardScoreEvents,
}));
vi.mock("../../lib/problem-deploy/handlers/participant-handler/update", () => ({
  setDisplayTeamName: mocks.setDisplayTeamName,
}));
vi.mock("../../lib/problem-deploy/handlers/participant-handler/submit-flag", () => ({
  submitFlag: mocks.submitFlag,
}));
vi.mock("../../lib/problem-deploy/handlers/participant-handler/reveal-hint", () => ({
  revealHint: mocks.revealHint,
}));
vi.mock("../../lib/problem-deploy/handlers/problem-endpoints-handler/endpoints", () => ({
  listProblemEndpoints: mocks.listProblemEndpoints,
  upsertProblemEndpointOverride: mocks.upsertProblemEndpointOverride,
  deleteProblemEndpointOverride: mocks.deleteProblemEndpointOverride,
}));
// const を持つ module は importOriginal で実値 (default / max) を残す。
vi.mock("../../lib/problem-deploy/handlers/participant-handler/notifications", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listNotifications: mocks.listNotifications,
}));
vi.mock("../../lib/problem-deploy/handlers/participant-handler/cast-event", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  castEvent: mocks.castEvent,
  readInbox: mocks.readInbox,
}));
vi.mock("../../lib/problem-deploy/handlers/participant-handler/battle-attacks", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listBattleAttacks: mocks.listBattleAttacks,
}));
vi.mock("../../lib/problem-deploy/handlers/participant-handler/deploy-logs", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getParticipantDeployLogs: mocks.getParticipantDeployLogs,
}));

const { app } = await import("../../lib/problem-deploy/handlers/participant-handler/index");

const JOB_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2"; // ULID
const PROBLEM_ID = "p-1";
const SLOT = "frontend";
const BASE_KEY = "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQ"; // 43-char base64url
let tokenSeq = 0;
/** request 毎に unique な 43-char token を返し、 in-memory rate limiter の bucket を分ける。 */
const auth = (): Record<string, string> => {
  tokenSeq += 1;
  const suffix = String(tokenSeq).padStart(5, "0");
  return { authorization: `Bearer ${BASE_KEY.slice(0, 43 - suffix.length)}${suffix}` };
};
const get = (path: string) => app.request(path, { headers: auth() });
const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { ...auth(), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe("GET /portal/healthz", () => {
  it("should return ok without auth", async () => {
    const res = await app.request("/portal/healthz");
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("GET /portal/me", () => {
  it("should 401 without a bearer token", async () => {
    expect((await app.request("/portal/me")).status).toBe(StatusCodes.UNAUTHORIZED);
  });
  it("should 401 when lookup misses", async () => {
    mocks.lookupTeamByLoginKey.mockResolvedValueOnce(null);
    expect((await get("/portal/me")).status).toBe(StatusCodes.UNAUTHORIZED);
  });
  it("should 200 with the team view on hit", async () => {
    mocks.lookupTeamByLoginKey.mockResolvedValueOnce({ team: { teamName: "A" }, problems: [] });
    const res = await get("/portal/me");
    expect(res.status).toBe(StatusCodes.OK);
    expect((await res.json()).team.teamName).toBe("A");
  });
});

describe("GET /portal/me/score-events", () => {
  it("should 401 when service returns unauthorized", async () => {
    mocks.listScoreEvents.mockResolvedValueOnce({ kind: "unauthorized" });
    expect((await get("/portal/me/score-events")).status).toBe(StatusCodes.UNAUTHORIZED);
  });
  it("should 200 with the score events", async () => {
    mocks.listScoreEvents.mockResolvedValueOnce({ kind: "ok", response: { events: [] } });
    const res = await get("/portal/me/score-events");
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ events: [] });
  });
});

describe("GET /portal/me/console-signin-url", () => {
  it("should 400 on an invalid jobId", async () => {
    expect((await get("/portal/me/console-signin-url?jobId=bad")).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
  it("should 200 with the loginUrl", async () => {
    mocks.getConsoleSigninUrl.mockResolvedValueOnce({ kind: "ok", loginUrl: "https://signin" });
    const res = await get(`/portal/me/console-signin-url?jobId=${JOB_ID}`);
    expect(res.status).toBe(StatusCodes.OK);
    expect((await res.json()).loginUrl).toBe("https://signin");
  });
  it("should 500 with stage + reason on assume_role_failed", async () => {
    mocks.getConsoleSigninUrl.mockResolvedValueOnce({
      kind: "assume_role_failed",
      stage: "sts",
      reason: "denied",
    });
    const res = await get(`/portal/me/console-signin-url?jobId=${JOB_ID}`);
    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    expect(await res.json()).toMatchObject({ stage: "sts", reason: "denied" });
  });
  it("should map other failure kinds via respondError", async () => {
    mocks.getConsoleSigninUrl.mockResolvedValueOnce({ kind: "misconfigured" });
    expect((await get(`/portal/me/console-signin-url?jobId=${JOB_ID}`)).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });
});

describe("GET /portal/me/cli-credentials", () => {
  it("should 400 on an invalid jobId", async () => {
    expect((await get("/portal/me/cli-credentials?jobId=bad")).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
  it("should 200 with credentials", async () => {
    mocks.getCliCredentials.mockResolvedValueOnce({ kind: "ok", credentials: { a: 1 } });
    const res = await get(`/portal/me/cli-credentials?jobId=${JOB_ID}`);
    expect(res.status).toBe(StatusCodes.OK);
    expect((await res.json()).credentials).toEqual({ a: 1 });
  });
  it("should 500 with stage + reason on assume_role_failed", async () => {
    mocks.getCliCredentials.mockResolvedValueOnce({
      kind: "assume_role_failed",
      stage: "federation",
      reason: "timeout",
    });
    const res = await get(`/portal/me/cli-credentials?jobId=${JOB_ID}`);
    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    expect(await res.json()).toMatchObject({ stage: "federation", reason: "timeout" });
  });
  it("should map other failure kinds via respondError", async () => {
    mocks.getCliCredentials.mockResolvedValueOnce({ kind: "misconfigured" });
    expect((await get(`/portal/me/cli-credentials?jobId=${JOB_ID}`)).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });
});

describe("GET /portal/me/notifications", () => {
  it("should 400 on a non-numeric limit", async () => {
    expect((await get("/portal/me/notifications?limit=abc")).status).toBe(StatusCodes.BAD_REQUEST);
  });
  it("should apply the default limit when omitted", async () => {
    mocks.listNotifications.mockResolvedValueOnce({ kind: "ok", response: { items: [] } });
    const res = await get("/portal/me/notifications");
    expect(res.status).toBe(StatusCodes.OK);
    expect(typeof mocks.listNotifications.mock.calls[0][2]).toBe("number"); // default applied
  });
  it("should pass an explicit limit through and map non-ok to an error", async () => {
    mocks.listNotifications.mockResolvedValueOnce({ kind: "not_found" });
    const res = await get("/portal/me/notifications?limit=5");
    expect(res.status).toBe(StatusCodes.NOT_FOUND);
    expect(mocks.listNotifications.mock.calls[0][2]).toBe(5);
  });
});

describe("POST /portal/me/cast-event", () => {
  const body = { targetJobId: JOB_ID, kind: "ally-request", payload: { x: 1 } };
  it("should 400 on an invalid body", async () => {
    expect((await send("POST", "/portal/me/cast-event", { kind: "x" })).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
  it("should 200 with eventId on success", async () => {
    mocks.castEvent.mockResolvedValueOnce({ kind: "ok", eventId: "e1", occurredAt: "t" });
    const res = await send("POST", "/portal/me/cast-event", body);
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ eventId: "e1", occurredAt: "t" });
  });
  it("should map a service failure to an error", async () => {
    mocks.castEvent.mockResolvedValueOnce({ kind: "target_not_found" });
    expect((await send("POST", "/portal/me/cast-event", body)).status).toBe(StatusCodes.NOT_FOUND);
  });
});

describe("GET /portal/me/event-inbox", () => {
  it("should 400 on an invalid jobId", async () => {
    expect((await get("/portal/me/event-inbox?jobId=bad")).status).toBe(StatusCodes.BAD_REQUEST);
  });
  it("should default sinceMs when omitted", async () => {
    mocks.readInbox.mockResolvedValueOnce({ kind: "ok", events: [] });
    const res = await get(`/portal/me/event-inbox?jobId=${JOB_ID}`);
    expect(res.status).toBe(StatusCodes.OK);
    expect(typeof mocks.readInbox.mock.calls[0][3]).toBe("number"); // computed default
  });
  it("should pass an explicit sinceMs and map non-ok to an error", async () => {
    mocks.readInbox.mockResolvedValueOnce({ kind: "no_event" });
    const res = await get(`/portal/me/event-inbox?jobId=${JOB_ID}&sinceMs=1000`);
    expect(res.status).toBe(StatusCodes.NOT_FOUND);
    expect(mocks.readInbox.mock.calls[0][3]).toBe(1000);
  });
});

describe("GET /portal/me/battle-attacks", () => {
  it("should 400 on an invalid jobId", async () => {
    expect((await get("/portal/me/battle-attacks?jobId=bad")).status).toBe(StatusCodes.BAD_REQUEST);
  });
  it("should default sinceMin when omitted", async () => {
    mocks.listBattleAttacks.mockResolvedValueOnce({ kind: "ok", response: { attacks: [] } });
    const res = await get(`/portal/me/battle-attacks?jobId=${JOB_ID}`);
    expect(res.status).toBe(StatusCodes.OK);
    expect(typeof mocks.listBattleAttacks.mock.calls[0][3]).toBe("number");
  });
  it("should pass an explicit sinceMin and map non-ok to an error", async () => {
    mocks.listBattleAttacks.mockResolvedValueOnce({ kind: "unauthorized" });
    const res = await get(`/portal/me/battle-attacks?jobId=${JOB_ID}&sinceMin=10`);
    expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    expect(mocks.listBattleAttacks.mock.calls[0][3]).toBe(10);
  });
});

describe("GET /portal/me/deploy-logs", () => {
  it("should 400 on an invalid jobId", async () => {
    expect((await get("/portal/me/deploy-logs?jobId=bad")).status).toBe(StatusCodes.BAD_REQUEST);
  });
  it("should 400 on an invalid limit", async () => {
    const res = await get(`/portal/me/deploy-logs?jobId=${JOB_ID}&limit=0`);
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("invalid_limit");
  });
  it("should 200 with the logs", async () => {
    mocks.getParticipantDeployLogs.mockResolvedValueOnce({ kind: "ok", response: { logs: [] } });
    expect((await get(`/portal/me/deploy-logs?jobId=${JOB_ID}`)).status).toBe(StatusCodes.OK);
  });
  it("should map a service failure to an error", async () => {
    mocks.getParticipantDeployLogs.mockResolvedValueOnce({ kind: "not_found" });
    expect((await get(`/portal/me/deploy-logs?jobId=${JOB_ID}`)).status).toBe(
      StatusCodes.NOT_FOUND,
    );
  });
});

describe("GET /portal/leaderboard(/score-events)", () => {
  it("should 200 with the leaderboard", async () => {
    mocks.getLeaderboard.mockResolvedValueOnce({ kind: "ok", response: { teams: [] } });
    expect((await get("/portal/leaderboard")).status).toBe(StatusCodes.OK);
  });
  it("should map a leaderboard failure to an error", async () => {
    mocks.getLeaderboard.mockResolvedValueOnce({ kind: "unauthorized" });
    expect((await get("/portal/leaderboard")).status).toBe(StatusCodes.UNAUTHORIZED);
  });
  it("should 200 with the leaderboard score events", async () => {
    mocks.getLeaderboardScoreEvents.mockResolvedValueOnce({ kind: "ok", response: { series: [] } });
    expect((await get("/portal/leaderboard/score-events")).status).toBe(StatusCodes.OK);
  });
  it("should map a leaderboard score-events failure to an error", async () => {
    mocks.getLeaderboardScoreEvents.mockResolvedValueOnce({ kind: "no_event" });
    expect((await get("/portal/leaderboard/score-events")).status).toBe(StatusCodes.NOT_FOUND);
  });
});

describe("PATCH /portal/me", () => {
  it("should 400 on an invalid body", async () => {
    expect((await send("PATCH", "/portal/me", { teamName: 123 })).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
  it("should 200 with the updated view", async () => {
    mocks.setDisplayTeamName.mockResolvedValueOnce({ kind: "ok", view: { teamName: "B" } });
    const res = await send("PATCH", "/portal/me", { teamName: "B" });
    expect(res.status).toBe(StatusCodes.OK);
    expect((await res.json()).teamName).toBe("B");
  });
  it("should map a service failure to an error", async () => {
    mocks.setDisplayTeamName.mockResolvedValueOnce({ kind: "invalid_team_name" });
    expect((await send("PATCH", "/portal/me", { teamName: "B" })).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
});

describe("POST /portal/me/submit-flag", () => {
  const body = { problemId: PROBLEM_ID, flag: "FLAG{x}" };
  it("should 400 on an invalid body", async () => {
    expect((await send("POST", "/portal/me/submit-flag", { flag: "" })).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
  it("should 409 with startsAt on scoring_not_started", async () => {
    mocks.submitFlag.mockResolvedValueOnce({ kind: "scoring_not_started", startsAt: "t1" });
    const res = await send("POST", "/portal/me/submit-flag", body);
    expect(res.status).toBe(StatusCodes.CONFLICT);
    expect(await res.json()).toMatchObject({ startsAt: "t1" });
  });
  it("should 409 with endsAt on scoring_ended", async () => {
    mocks.submitFlag.mockResolvedValueOnce({ kind: "scoring_ended", endsAt: "t2" });
    const res = await send("POST", "/portal/me/submit-flag", body);
    expect(res.status).toBe(StatusCodes.CONFLICT);
    expect(await res.json()).toMatchObject({ endsAt: "t2" });
  });
  it.each([
    ["unauthorized", StatusCodes.UNAUTHORIZED],
    ["not_flag_problem", StatusCodes.BAD_REQUEST],
    ["no_outputs", StatusCodes.BAD_REQUEST],
    ["scoring_locked", StatusCodes.CONFLICT],
  ])("should map the %s outcome to an error", async (kind, status) => {
    mocks.submitFlag.mockResolvedValueOnce({ kind });
    expect((await send("POST", "/portal/me/submit-flag", body)).status).toBe(status);
  });
  it("should 200 on a successful submission", async () => {
    mocks.submitFlag.mockResolvedValueOnce({ kind: "ok", awardedPoints: 100 });
    const res = await send("POST", "/portal/me/submit-flag", body);
    expect(res.status).toBe(StatusCodes.OK);
    expect((await res.json()).awardedPoints).toBe(100);
  });
});

describe("POST /portal/me/problems/:problemId/hints/:hintId/reveal", () => {
  const path = `/portal/me/problems/${PROBLEM_ID}/hints/h1/reveal`;
  it("should 400 on an invalid problemId param", async () => {
    expect((await send("POST", "/portal/me/problems/Bad_ID/hints/h1/reveal")).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
  it("should 409 with startsAt on scoring_not_started", async () => {
    mocks.revealHint.mockResolvedValueOnce({ kind: "scoring_not_started", startsAt: "t1" });
    const res = await send("POST", path);
    expect(res.status).toBe(StatusCodes.CONFLICT);
    expect(await res.json()).toMatchObject({ startsAt: "t1" });
  });
  it("should 409 with endsAt on scoring_ended", async () => {
    mocks.revealHint.mockResolvedValueOnce({ kind: "scoring_ended", endsAt: "t2" });
    const res = await send("POST", path);
    expect(res.status).toBe(StatusCodes.CONFLICT);
    expect(await res.json()).toMatchObject({ endsAt: "t2" });
  });
  it("should 409 with missingHintId on hint_out_of_order", async () => {
    mocks.revealHint.mockResolvedValueOnce({ kind: "hint_out_of_order", missingHintId: "h0" });
    const res = await send("POST", path);
    expect(res.status).toBe(StatusCodes.CONFLICT);
    expect(await res.json()).toMatchObject({ missingHintId: "h0" });
  });
  it.each([
    ["unauthorized", StatusCodes.UNAUTHORIZED],
    ["not_flag_problem", StatusCodes.BAD_REQUEST],
    ["unknown_hint", StatusCodes.NOT_FOUND],
    ["scoring_locked", StatusCodes.CONFLICT],
  ])("should map the %s outcome to an error", async (kind, status) => {
    mocks.revealHint.mockResolvedValueOnce({ kind });
    expect((await send("POST", path)).status).toBe(status);
  });
  it("should 200 on a successful reveal", async () => {
    mocks.revealHint.mockResolvedValueOnce({ kind: "ok", content: "hint", score: -5 });
    const res = await send("POST", path);
    expect(res.status).toBe(StatusCodes.OK);
    expect((await res.json()).content).toBe("hint");
  });
});

describe("GET /portal/me/problems/:problemId/endpoints", () => {
  const path = `/portal/me/problems/${PROBLEM_ID}/endpoints`;
  it("should 400 on an invalid problemId param", async () => {
    expect((await get("/portal/me/problems/Bad_ID/endpoints")).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
  it("should 200 with endpoints + teamId", async () => {
    mocks.listProblemEndpoints.mockResolvedValueOnce({ kind: "ok", endpoints: [], teamId: "t1" });
    const res = await get(path);
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ endpoints: [], teamId: "t1" });
  });
  it("should map a service failure to an error", async () => {
    mocks.listProblemEndpoints.mockResolvedValueOnce({ kind: "no_endpoints" });
    expect((await get(path)).status).toBe(StatusCodes.NOT_FOUND);
  });
});

describe("POST /portal/me/problems/:problemId/endpoints/:slot", () => {
  const path = `/portal/me/problems/${PROBLEM_ID}/endpoints/${SLOT}`;
  it("should 400 on an invalid slot param", async () => {
    const res = await send("POST", `/portal/me/problems/${PROBLEM_ID}/endpoints/Bad_Slot`, {
      url: "https://x",
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
  });
  it("should 400 on an invalid body", async () => {
    expect((await send("POST", path, { notUrl: 1 })).status).toBe(StatusCodes.BAD_REQUEST);
  });
  it("should 200 with endpoints + teamId", async () => {
    mocks.upsertProblemEndpointOverride.mockResolvedValueOnce({
      kind: "ok",
      endpoints: [],
      teamId: "t1",
    });
    const res = await send("POST", path, { url: "https://x" });
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ endpoints: [], teamId: "t1" });
  });
  it("should map a service failure to an error", async () => {
    mocks.upsertProblemEndpointOverride.mockResolvedValueOnce({ kind: "invalid_url" });
    expect((await send("POST", path, { url: "ftp://x" })).status).toBe(StatusCodes.BAD_REQUEST);
  });
});

describe("DELETE /portal/me/problems/:problemId/endpoints/:slot", () => {
  const path = `/portal/me/problems/${PROBLEM_ID}/endpoints/${SLOT}`;
  it("should 400 on an invalid slot param", async () => {
    expect(
      (await send("DELETE", `/portal/me/problems/${PROBLEM_ID}/endpoints/Bad_Slot`)).status,
    ).toBe(StatusCodes.BAD_REQUEST);
  });
  it("should 200 with endpoints + teamId", async () => {
    mocks.deleteProblemEndpointOverride.mockResolvedValueOnce({
      kind: "ok",
      endpoints: [],
      teamId: "t1",
    });
    const res = await send("DELETE", path);
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ endpoints: [], teamId: "t1" });
  });
  it("should map a service failure to an error", async () => {
    mocks.deleteProblemEndpointOverride.mockResolvedValueOnce({ kind: "slot_not_overridable" });
    expect((await send("DELETE", path)).status).toBe(StatusCodes.CONFLICT);
  });
});

// Issue #1420: coordination の op/projection route は専用 CoordinationDispatcherLambda
// (coordination-dispatcher-handler) へ分離した。 route glue の test は coordination-dispatcher-index.test.ts。
describe("coordination routes are no longer served by the participant-portal Lambda", () => {
  it("should 404 POST /portal/me/coordination/op (moved to the dedicated dispatcher)", async () => {
    expect((await send("POST", "/portal/me/coordination/op", { op: {} })).status).toBe(
      StatusCodes.NOT_FOUND,
    );
  });
  it("should 404 GET /portal/me/coordination/projection (moved to the dedicated dispatcher)", async () => {
    expect((await get("/portal/me/coordination/projection")).status).toBe(StatusCodes.NOT_FOUND);
  });
});
