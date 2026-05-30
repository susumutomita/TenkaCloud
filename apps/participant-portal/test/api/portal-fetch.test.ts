import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PortalAssumeRoleError,
  PortalAuthError,
  PortalNetworkError,
  PortalScoringGateError,
  PortalValidationError,
} from "../../src/api/portal-client/errors";
import { portalFetch } from "../../src/api/portal-client/fetch";

/**
 * portalFetch 共通層の error mapping を網羅する。 公開 endpoint (team.ts 等) は option 組合せ
 * の一部しか踏まないため、 fetch 層を直接呼んで 401 / 400 / 409 (scoring gate / hint /
 * generic) / 500 (assume_role_failed / 他) / !ok / 404 / 不正 JSON body の各経路を pin する。
 */
const BASE = "https://api.example.com";
const KEY = "team-login-key";

const mockFetch = (res: unknown) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
const jsonRes = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

afterEach(() => vi.restoreAllMocks());

describe("portalFetch", () => {
  it("should return parsed JSON on 200", async () => {
    mockFetch(jsonRes(200, { ok: true }));
    await expect(portalFetch(BASE, "thing", KEY)).resolves.toEqual({ ok: true });
  });

  it("should return undefined on 404 when returnUndefinedOn404 is set", async () => {
    mockFetch(jsonRes(404, {}));
    await expect(
      portalFetch(BASE, "thing", KEY, { returnUndefinedOn404: true }),
    ).resolves.toBeUndefined();
  });

  it("should throw PortalAuthError on 401", async () => {
    mockFetch(jsonRes(401, {}));
    await expect(portalFetch(BASE, "thing", KEY)).rejects.toBeInstanceOf(PortalAuthError);
  });

  it("should throw PortalValidationError with the body error on 400 (throwOn400)", async () => {
    mockFetch(jsonRes(400, { error: "bad_slug" }));
    await expect(portalFetch(BASE, "thing", KEY, { throwOn400: true })).rejects.toMatchObject({
      name: "PortalValidationError",
      errorCode: "bad_slug",
    });
  });

  it("should fall back to invalid_request on 400 with no body error", async () => {
    mockFetch(jsonRes(400, {}));
    await expect(portalFetch(BASE, "thing", KEY, { throwOn400: true })).rejects.toMatchObject({
      errorCode: "invalid_request",
    });
  });

  it("should throw PortalScoringGateError for a scoring-gate 409 (throwOn409)", async () => {
    mockFetch(jsonRes(409, { error: "scoring_not_started", startsAt: "2026-06-01T00:00:00Z" }));
    const err = await portalFetch(BASE, "score", KEY, { throwOn409: true }).catch((e) => e);
    expect(err).toBeInstanceOf(PortalScoringGateError);
    expect((err as PortalScoringGateError).kind).toBe("scoring_not_started");
    expect((err as PortalScoringGateError).startsAt).toBe("2026-06-01T00:00:00Z");
  });

  it("should carry missingHintId for a hint_out_of_order 409", async () => {
    mockFetch(jsonRes(409, { error: "hint_out_of_order", missingHintId: "h2" }));
    const err = await portalFetch(BASE, "hint", KEY, { throwOn409: true }).catch((e) => e);
    expect(err).toBeInstanceOf(PortalValidationError);
    expect((err as PortalValidationError).errorCode).toBe("hint_out_of_order");
    expect((err as PortalValidationError).details).toEqual({ missingHintId: "h2" });
  });

  it("should fall back to conflict on a 409 with an unparseable body", async () => {
    // 不正 JSON → readPortalErrorBody の catch → {} → body.error 不在 → "conflict"。
    mockFetch(jsonRes(409, "not-json{"));
    await expect(portalFetch(BASE, "x", KEY, { throwOn409: true })).rejects.toMatchObject({
      errorCode: "conflict",
    });
  });

  it("should throw PortalAssumeRoleError for assume_role_failed 500 (throwOnAssumeRoleFailed)", async () => {
    mockFetch(
      jsonRes(500, {
        error: "assume_role_failed",
        stage: "participant_viewer",
        reason: "AccessDenied",
      }),
    );
    const err = await portalFetch(BASE, "x", KEY, { throwOnAssumeRoleFailed: true }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(PortalAssumeRoleError);
    expect((err as PortalAssumeRoleError).stage).toBe("participant_viewer");
    expect((err as PortalAssumeRoleError).reason).toBe("AccessDenied");
  });

  it("should default the stage to competitor and reason to Unknown for a malformed assume_role_failed", async () => {
    mockFetch(jsonRes(500, { error: "assume_role_failed", stage: "bogus" }));
    const err = await portalFetch(BASE, "x", KEY, { throwOnAssumeRoleFailed: true }).catch(
      (e) => e,
    );
    expect((err as PortalAssumeRoleError).stage).toBe("competitor");
    expect((err as PortalAssumeRoleError).reason).toBe("Unknown");
  });

  it("should fall back to PortalNetworkError for a non-assume-role 500 under throwOnAssumeRoleFailed", async () => {
    mockFetch(jsonRes(500, {}));
    const err = await portalFetch(BASE, "x", KEY, { throwOnAssumeRoleFailed: true }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(PortalNetworkError);
    expect((err as PortalNetworkError).status).toBe(500);
  });

  it("should throw PortalNetworkError for a generic !ok response, tolerating a failing body read", async () => {
    // text() が reject → catch(() => "") → body 空 → "unknown" 文言。
    mockFetch({
      status: 503,
      ok: false,
      text: () => Promise.reject(new Error("stream error")),
      json: () => Promise.reject(new Error("stream error")),
    });
    const err = await portalFetch(BASE, "x", KEY).catch((e) => e);
    expect(err).toBeInstanceOf(PortalNetworkError);
    expect((err as PortalNetworkError).status).toBe(503);
    expect((err as Error).message).toContain("unknown");
  });
});
