import { StatusCodes } from "http-status-codes";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADR-030 Phase 2 (#1420): 専用 CoordinationDispatcherLambda (coordination-dispatcher-handler) の
 * route glue を pin する。 coordination-handler / shared を mock し、 op/projection の outcome→HTTP
 * 写像 + bearer auth を検証する (= participant-handler から移設した route の挙動保存)。
 */
const mocks = vi.hoisted(() => ({
  handleCoordinationOp: vi.fn(),
  handleCoordinationProjection: vi.fn(),
}));

vi.mock("../../lib/problem-deploy/handlers/participant-handler/shared", () => ({
  buildParticipantSharedResources: () => ({
    ddb: { send: vi.fn() },
    tableName: "T",
    eventsTableName: "",
    endpointsTableName: "",
    problemsScoring: {},
    problemsEndpoints: {},
  }),
}));
vi.mock("../../lib/problem-deploy/handlers/participant-handler/coordination-handler", () => ({
  handleCoordinationOp: mocks.handleCoordinationOp,
  handleCoordinationProjection: mocks.handleCoordinationProjection,
  makeCoordinationScopeResolver: () => async () => null,
  parseCoordinationConfig: () => ({}),
}));

const { app } = await import(
  "../../lib/problem-deploy/handlers/coordination-dispatcher-handler/index"
);

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

describe("coordination dispatcher healthz", () => {
  it("should serve healthz", async () => {
    const res = await app.request("/portal/healthz");
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("POST /portal/me/coordination/op", () => {
  const OP = "/portal/me/coordination/op";
  it("should 401 without a bearer token", async () => {
    expect((await app.request(OP, { method: "POST" })).status).toBe(StatusCodes.UNAUTHORIZED);
  });
  it("should 200 with the projection on ok", async () => {
    mocks.handleCoordinationOp.mockResolvedValueOnce({ kind: "ok", projection: { count: 1 } });
    const res = await send("POST", OP, { op: { kind: "inc" } });
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ projection: { count: 1 } });
  });
  it("should 422 with the error on a plugin rejection", async () => {
    mocks.handleCoordinationOp.mockResolvedValueOnce({ kind: "rejected", error: "bad_op" });
    const res = await send("POST", OP, { op: { kind: "bad" } });
    expect(res.status).toBe(StatusCodes.UNPROCESSABLE_ENTITY);
    expect(await res.json()).toEqual({ error: "bad_op" });
  });
  it("should 409 on a write conflict", async () => {
    mocks.handleCoordinationOp.mockResolvedValueOnce({ kind: "conflict" });
    expect((await send("POST", OP, { op: {} })).status).toBe(StatusCodes.CONFLICT);
  });
  it("should 503 when the plugin is unavailable (importer seam)", async () => {
    mocks.handleCoordinationOp.mockResolvedValueOnce({ kind: "unavailable" });
    expect((await send("POST", OP, { op: {} })).status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
  });
  it("should 404 when coordination is not configured for the team", async () => {
    mocks.handleCoordinationOp.mockResolvedValueOnce({ kind: "not_configured" });
    expect((await send("POST", OP, { op: {} })).status).toBe(StatusCodes.NOT_FOUND);
  });
});

describe("GET /portal/me/coordination/projection", () => {
  const PROJ = "/portal/me/coordination/projection";
  it("should 401 without a bearer token", async () => {
    expect((await app.request(PROJ)).status).toBe(StatusCodes.UNAUTHORIZED);
  });
  it("should 200 with the team projection", async () => {
    mocks.handleCoordinationProjection.mockResolvedValueOnce({
      kind: "ok",
      projection: { allies: [] },
    });
    const res = await get(PROJ);
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ projection: { allies: [] } });
  });
  it("should 404 when coordination is not configured", async () => {
    mocks.handleCoordinationProjection.mockResolvedValueOnce({ kind: "not_configured" });
    expect((await get(PROJ)).status).toBe(StatusCodes.NOT_FOUND);
  });
});
