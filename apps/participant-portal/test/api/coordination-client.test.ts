import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCoordinationProjection, submitCoordinationOp } from "../../src/api/coordination-client";

/**
 * #1420: coordination-client。 dispatcher の各 HTTP status を CoordinationOutcome へ写す mapping と、
 * op (POST) / projection (GET) の URL / bearer / body を pin する。
 */
const URL_BASE = "https://coord.example.com";

function mockFetch(status: number, body?: unknown) {
  return vi.fn().mockResolvedValue({
    status,
    json: async () => body ?? {},
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch(200, { projection: { count: 1 } }));
});
afterEach(() => vi.unstubAllGlobals());

describe("submitCoordinationOp", () => {
  it("should POST the op with bearer auth and return the projection on 200", async () => {
    const f = mockFetch(200, { projection: { allies: ["t2"] } });
    vi.stubGlobal("fetch", f);
    const out = await submitCoordinationOp(URL_BASE, "key-1", { kind: "ally" });
    expect(out).toEqual({ kind: "ok", projection: { allies: ["t2"] } });
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe("https://coord.example.com/portal/me/coordination/op");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer key-1" });
    expect((init as RequestInit).body).toBe(JSON.stringify({ op: { kind: "ally" } }));
  });

  it("should map 422 to rejected with the backend error", async () => {
    vi.stubGlobal("fetch", mockFetch(422, { error: "bad_op" }));
    expect(await submitCoordinationOp(URL_BASE, "k", {})).toEqual({
      kind: "rejected",
      error: "bad_op",
    });
  });

  it("should map 422 to rejected with a default when the body has no error / is unreadable", async () => {
    vi.stubGlobal("fetch", {
      // body 読み取り失敗 → catch → {} → error ?? "rejected"
      ...mockFetch(422),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 422,
        json: async () => {
          throw new Error("bad json");
        },
      }),
    );
    expect(await submitCoordinationOp(URL_BASE, "k", {})).toEqual({
      kind: "rejected",
      error: "rejected",
    });
  });

  it("should map 409 to conflict", async () => {
    vi.stubGlobal("fetch", mockFetch(409));
    expect(await submitCoordinationOp(URL_BASE, "k", {})).toEqual({ kind: "conflict" });
  });

  it("should map 503 to unavailable", async () => {
    vi.stubGlobal("fetch", mockFetch(503));
    expect(await submitCoordinationOp(URL_BASE, "k", {})).toEqual({ kind: "unavailable" });
  });

  it("should map 401 to unauthorized", async () => {
    vi.stubGlobal("fetch", mockFetch(401));
    expect(await submitCoordinationOp(URL_BASE, "k", {})).toEqual({ kind: "unauthorized" });
  });

  it("should map 404 (and other statuses) to not_configured", async () => {
    vi.stubGlobal("fetch", mockFetch(404));
    expect(await submitCoordinationOp(URL_BASE, "k", {})).toEqual({ kind: "not_configured" });
  });
});

describe("getCoordinationProjection", () => {
  it("should GET the projection with bearer auth and normalize a trailing-slash base", async () => {
    const f = mockFetch(200, { projection: { count: 3 } });
    vi.stubGlobal("fetch", f);
    const out = await getCoordinationProjection("https://coord.example.com/", "key-2");
    expect(out).toEqual({ kind: "ok", projection: { count: 3 } });
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe("https://coord.example.com/portal/me/coordination/projection");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer key-2" });
    expect((init as RequestInit).method ?? "GET").toBe("GET");
  });

  it("should map not_configured (404) for a team whose problem declares no coordination", async () => {
    vi.stubGlobal("fetch", mockFetch(404));
    expect(await getCoordinationProjection(URL_BASE, "k")).toEqual({ kind: "not_configured" });
  });
});
