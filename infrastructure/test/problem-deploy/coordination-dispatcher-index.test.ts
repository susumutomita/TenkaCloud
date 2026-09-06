import { StatusCodes } from "http-status-codes";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1420: 専用 CoordinationDispatcherLambda (coordination-dispatcher-handler) の
 * route glue を pin する。 coordination-handler / shared を mock し、 op/projection の outcome→HTTP
 * 写像 + bearer auth を検証する (= participant-handler から移設した route の挙動保存)。
 */
const mocks = vi.hoisted(() => ({
  handleCoordinationOp: vi.fn(),
  handleCoordinationProjection: vi.fn(),
  handleCoordinationArtifactFetch: vi.fn(),
  normalRuntime: {},
  deliveryRuntime: {},
  normalDdb: { send: vi.fn() },
  deliveryDdb: { send: vi.fn() },
  resolveScope: vi.fn(),
}));

vi.mock("../../lib/problem-deploy/control-data/runtime-repositories", () => ({
  createDefaultControlDataRuntime: () => mocks.normalRuntime,
}));
vi.mock(
  "../../lib/problem-deploy/handlers/coordination-dispatcher-handler/coordination-backends",
  () => ({
    createScoreDeliveryControlDataRuntime: () => mocks.deliveryRuntime,
    createScoreDeliveryDdbClient: () => mocks.deliveryDdb,
  }),
);
vi.mock("../../lib/problem-deploy/handlers/participant-handler/shared", () => ({
  buildParticipantSharedResources: (runtime: unknown, ddb = mocks.normalDdb) => ({
    runtime,
    ddb,
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
  // [Issue #3152] The on-demand body fetch that keeps the projection carrying
  // references only.
  handleCoordinationArtifactFetch: mocks.handleCoordinationArtifactFetch,
  makeCoordinationScopeResolver: (shared: unknown) => async () => mocks.resolveScope(shared),
  // [Issue #659] The dispatcher wires a score publisher so a coordination
  // Battle's own scoring reaches the scoreboard.
  makeCoordinationScorePublisher: () => async () => undefined,
  parseCoordinationConfig: () => ({
    pure: { plugin: "pure", scoreMode: "exclusive" },
    mixed: { plugin: "mixed", scoreMode: "additive" },
    legacy: { plugin: "legacy" },
  }),
}));

const { app, handler } = await import(
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
  it("passes catalog score ownership into the operation and projection store", async () => {
    mocks.handleCoordinationOp.mockResolvedValueOnce({ kind: "ok", projection: {} });
    await send("POST", OP, { op: {} });
    expect(mocks.handleCoordinationOp.mock.calls[0]?.[0].store.coordinationScoreModes).toEqual({
      pure: "exclusive",
      mixed: "additive",
      legacy: "additive",
    });
  });
  it("isolates score delivery limits from operation, projection, and scope lookup", async () => {
    mocks.handleCoordinationOp.mockResolvedValueOnce({ kind: "ok", projection: {} });
    mocks.handleCoordinationProjection.mockResolvedValueOnce({ kind: "ok", projection: {} });
    await send("POST", OP, { op: {} });
    await get("/portal/me/coordination/projection");
    const deps = mocks.handleCoordinationOp.mock.calls[0]?.[0];
    expect(mocks.handleCoordinationProjection.mock.calls[0]?.[0]).toBe(deps);
    expect(deps.store.runtime).toBe(mocks.normalRuntime);
    expect(deps.store.ddb).toBe(mocks.normalDdb);
    expect(deps.store.scoreDelivery).toEqual({
      runtime: mocks.deliveryRuntime,
      ddb: mocks.deliveryDdb,
      tableName: deps.store.tableName,
    });
    await deps.resolveScope("fixture-key");
    expect(mocks.resolveScope).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: mocks.normalRuntime, ddb: mocks.normalDdb }),
    );
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
  /**
   * [Issue #3150] Distinct from `unavailable` -- `unavailable` means the
   * plugin could not be loaded at all, `state_schema_mismatch` means it
   * loaded fine but the persisted row's schema version could not be
   * reconciled against it. Both are 503, but the error string lets an
   * operator tell them apart instead of both looking like the same outage.
   */
  it("should 503 with state_schema_mismatch when the row's schema version cannot be reconciled", async () => {
    mocks.handleCoordinationOp.mockResolvedValueOnce({
      kind: "schema_mismatch",
      reason: "newer_row",
    });
    const res = await send("POST", OP, { op: {} });
    expect(res.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
    expect(await res.json()).toEqual({ error: "state_schema_mismatch", reason: "newer_row" });
  });
  /**
   * [Issue #3170] The Progression Gate reaches this route now.
   *
   * 403 rather than 404: the request is well formed and authenticated, and the
   * reason is that the problem is not open yet. `default` would map it to
   * `not_configured`, telling the participant the problem does not exist — and
   * they would then read a completed Gate as having changed nothing.
   */
  it("should 403 with the gate problem when the prerequisite is unmet", async () => {
    mocks.handleCoordinationOp.mockResolvedValueOnce({
      kind: "locked",
      gateProblemId: "hello-world",
    });
    const res = await send("POST", OP, { op: {} });
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect(await res.json()).toEqual({
      error: "challenge_prerequisite_not_met",
      gateProblemId: "hello-world",
    });
  });

  it("should 404 when coordination is not configured for the team", async () => {
    mocks.handleCoordinationOp.mockResolvedValueOnce({ kind: "not_configured" });
    expect((await send("POST", OP, { op: {} })).status).toBe(StatusCodes.NOT_FOUND);
  });

  /**
   * [Issue #3125] A team with TWO coordination problems and no `problemId`.
   *
   * This arm exists because `respondCoordination`'s `default` maps to 404
   * `not_configured` — without it, a team that has two problems would be told
   * there is no such problem, which is the original "the second one is
   * unreachable" bug wearing a different status code.
   */
  it("should 409 with the candidates when the problem is ambiguous", async () => {
    mocks.handleCoordinationOp.mockResolvedValueOnce({
      kind: "ambiguous",
      problemIds: ["p1", "p2"],
    });
    const res = await send("POST", OP, { op: {} });
    expect(res.status).toBe(StatusCodes.CONFLICT);
    expect(await res.json()).toEqual({ error: "ambiguous_problem", problemIds: ["p1", "p2"] });
  });

  it("should forward the body's problemId to the handler", async () => {
    mocks.handleCoordinationOp.mockResolvedValueOnce({ kind: "ok", projection: {} });
    await send("POST", OP, { op: { kind: "inc" }, problemId: "p2" });
    expect(mocks.handleCoordinationOp).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      { kind: "inc" },
      expect.any(String),
      "p2",
      // [Issue #3152] The artifacts slot, empty for an op that submits none.
      undefined,
    );
  });

  it("should leave problemId undefined when the body omits it", async () => {
    // The single-problem case, which must keep working untouched.
    mocks.handleCoordinationOp.mockResolvedValueOnce({ kind: "ok", projection: {} });
    await send("POST", OP, { op: { kind: "inc" } });
    expect(mocks.handleCoordinationOp).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      { kind: "inc" },
      expect.any(String),
      undefined,
      undefined,
    );
  });

  it("should forward submitted artifact bodies to the handler (#3152)", async () => {
    // The route passes them through unvalidated on purpose: the limits live
    // next to the code that stores the bytes, so the two cannot disagree about
    // what was accepted.
    mocks.handleCoordinationOp.mockResolvedValueOnce({ kind: "ok", projection: {} });
    const artifacts = { proof: { contentType: "application/octet-stream", contentBase64: "aGk=" } };
    await send("POST", OP, { op: { kind: "PROVE" }, artifacts });
    expect(mocks.handleCoordinationOp).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      { kind: "PROVE" },
      expect.any(String),
      undefined,
      artifacts,
    );
  });

  it("should answer 507 when the state no longer fits the backend (#3151)", async () => {
    // Distinct from the 409 a conflict gets: a conflict is worth retrying and
    // this is not, because the state does not get smaller by being retried.
    mocks.handleCoordinationOp.mockResolvedValueOnce({
      kind: "too_large",
      bytes: 999,
      budget: { backend: "dynamodb", maxBytes: 500, warnBytes: 250 },
    });
    const res = await send("POST", OP, { op: {} });
    expect(res.status).toBe(StatusCodes.INSUFFICIENT_STORAGE);
    expect(await res.json()).toEqual({
      error: "state_over_budget",
      bytes: 999,
      maxBytes: 500,
      backend: "dynamodb",
    });
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

  /**
   * [Issue #3150] The projection route is the most-polled path, so this is
   * the case the design is most protective of: a mismatch must not fold into
   * a 200 with an empty/fallback board. It gets the same 503 the op route
   * does, never a quiet-looking success.
   */
  it("should 503 with state_schema_mismatch instead of folding into a 200 projection", async () => {
    mocks.handleCoordinationProjection.mockResolvedValueOnce({
      kind: "schema_mismatch",
      reason: "missing_migration",
    });
    const res = await get(PROJ);
    expect(res.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
    expect(await res.json()).toEqual({
      error: "state_schema_mismatch",
      reason: "missing_migration",
    });
  });

  it("should 409 with the candidates when the problem is ambiguous", async () => {
    mocks.handleCoordinationProjection.mockResolvedValueOnce({
      kind: "ambiguous",
      problemIds: ["p1", "p2"],
    });
    const res = await get(PROJ);
    expect(res.status).toBe(StatusCodes.CONFLICT);
    expect(await res.json()).toEqual({ error: "ambiguous_problem", problemIds: ["p1", "p2"] });
  });

  it("should forward the query's problemId to the handler", async () => {
    // [Issue #3125] GET carries it in the query, POST in the body.
    mocks.handleCoordinationProjection.mockResolvedValueOnce({ kind: "ok", projection: {} });
    await get(`${PROJ}?problemId=p2`);
    expect(mocks.handleCoordinationProjection).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "p2",
    );
  });

  it("should treat an empty problemId as absent", async () => {
    // `?problemId=` must not resolve "the problem named empty string", which
    // would be `not_configured` for every team.
    mocks.handleCoordinationProjection.mockResolvedValueOnce({ kind: "ok", projection: {} });
    await get(`${PROJ}?problemId=`);
    expect(mocks.handleCoordinationProjection).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      undefined,
    );
  });
});

// [#2324] direct Invoke の tick batch は Hono を通さず本 Lambda 内で処理する。 それ以外の
// (= Function URL) HTTP event は従来どおり Hono app に委譲する (= op / projection 経路は不変)。
describe("handler (scoring-driven tick batch vs HTTP delegation)", () => {
  it("should process a coordination-tick batch invoke without going through Hono", async () => {
    // parseCoordinationConfig は {} に mock されているため、 宣言 gate で全 target が skip される
    // (= plugin load / store 到達なし)。 tick 経路 (= Hono を通らない) を通ったことを結果形で確認する。
    const res = await handler(
      {
        action: "coordination-tick",
        nowIso: "2026-06-01T00:00:00.000Z",
        targets: [
          { tenantId: "t1", eventId: "e1", moduleRef: "cap", eventNowMs: 900_000, teamIds: [] },
        ],
      },
      {} as never,
    );
    expect(res).toEqual({ ticked: 1, written: 0 });
  });

  it("should delegate a Function URL HTTP event to the Hono app", async () => {
    const httpEvent = {
      version: "2.0",
      routeKey: "$default",
      rawPath: "/portal/healthz",
      rawQueryString: "",
      headers: {},
      requestContext: {
        http: {
          method: "GET",
          path: "/portal/healthz",
          protocol: "HTTP/1.1",
          sourceIp: "1.2.3.4",
          userAgent: "vitest",
        },
      },
      isBase64Encoded: false,
    };
    const res = (await handler(httpEvent, {} as never)) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(StatusCodes.OK);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});

describe("GET /portal/me/coordination/artifact/:artifactId (#3152)", () => {
  const ARTIFACT = "/portal/me/coordination/artifact/abc123";

  it("should return the body as bytes with its media type and digest", async () => {
    mocks.handleCoordinationArtifactFetch.mockResolvedValueOnce({
      kind: "ok",
      artifact: {
        content: new TextEncoder().encode("share-value"),
        ref: {
          artifactId: "abc123",
          contentType: "application/octet-stream",
          bytes: 11,
          digest: "f".repeat(64),
          writtenAtMs: 1,
        },
      },
    });

    const res = await get(ARTIFACT);

    // Bytes, not JSON: these are proofs and ciphertexts, and re-encoding would
    // inflate every fetch by a third for nobody's benefit.
    expect(res.status).toBe(StatusCodes.OK);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-tenkacloud-artifact-digest")).toBe("f".repeat(64));
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("share-value");
  });

  it("should forward the requested id and the optional problemId", async () => {
    mocks.handleCoordinationArtifactFetch.mockResolvedValueOnce({ kind: "not_found" });
    await get(`${ARTIFACT}?problemId=p2`);
    expect(mocks.handleCoordinationArtifactFetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "abc123",
      "p2",
    );
  });

  it("should answer 404 for an artifact this team may not read", async () => {
    // Same status as one that does not exist, so a participant cannot probe
    // which ids exist in a match they cannot see.
    mocks.handleCoordinationArtifactFetch.mockResolvedValueOnce({ kind: "not_found" });
    const res = await get(ARTIFACT);
    expect(res.status).toBe(StatusCodes.NOT_FOUND);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("should pass a scope resolution failure through the shared mapping", async () => {
    mocks.handleCoordinationArtifactFetch.mockResolvedValueOnce({ kind: "not_configured" });
    const res = await get(ARTIFACT);
    expect(res.status).toBe(StatusCodes.NOT_FOUND);
    expect(await res.json()).toEqual({ error: "not_configured" });
  });

  it("should answer 503 when the board the fetch is authorized against cannot be built", async () => {
    mocks.handleCoordinationArtifactFetch.mockResolvedValueOnce({
      kind: "schema_mismatch",
      reason: "missing_migration",
    });
    const res = await get(ARTIFACT);
    expect(res.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
    expect(await res.json()).toEqual({
      error: "state_schema_mismatch",
      reason: "missing_migration",
    });
  });
});
