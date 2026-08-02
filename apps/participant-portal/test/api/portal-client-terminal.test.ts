import { afterEach, describe, expect, it, vi } from "vitest";
import {
  issueProblemTerminalHandoff,
  PortalNetworkError,
  problemTerminalUrl,
} from "../../src/api/portal-client";

/**
 * [#2846] terminal.ts の contract pin。 backend (別 agent、scripts/local-play/) との契約:
 *   POST .../terminal-handoff → 200 {ticket, expiresInMs} / 404 {error:"unknown_problem"} /
 *   409 {error:"not_running"}
 *   WS {http→ws, https→wss} .../terminal?ticket={ticket}
 * を issueProblemConsoleHandoff (lifecycle.ts) と同じ流儀 (portalFetch, PortalNetworkError) で pin する。
 */
const KEY = "AbCdEfGhIjKlMnOpQrStUvWx";
const API = "https://api.example.com";

const mockFetch = (res: Response) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("issueProblemTerminalHandoff", () => {
  it("should POST the encoded terminal-handoff endpoint with Bearer auth and return only the ticket", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonRes(200, { ticket: "opaque-one-time", expiresInMs: 30_000 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await issueProblemTerminalHandoff(API, KEY, "sha256/level-1");

    expect(result).toBe("opaque-one-time");
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://api.example.com/portal/me/problems/sha256%2Flevel-1/terminal-handoff",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it("should reject with PortalValidationError(not_running) on 409 (container not started)", async () => {
    mockFetch(jsonRes(409, { error: "not_running" }));
    await expect(issueProblemTerminalHandoff(API, KEY, "p1")).rejects.toMatchObject({
      name: "PortalValidationError",
      errorCode: "not_running",
    });
  });

  it("should reject with PortalNetworkError(404) on unknown_problem, without swallowing it", async () => {
    mockFetch(jsonRes(404, { error: "unknown_problem" }));
    const err = await issueProblemTerminalHandoff(API, KEY, "ghost").catch((e) => e);
    expect(err).toBeInstanceOf(PortalNetworkError);
    expect((err as PortalNetworkError).status).toBe(404);
  });

  it("should fail loudly (502 invalid_terminal_handoff) when the backend returns 200 without a ticket", async () => {
    mockFetch(jsonRes(200, { expiresInMs: 30_000 }));
    await expect(issueProblemTerminalHandoff(API, KEY, "p1")).rejects.toMatchObject({
      name: "PortalNetworkError",
      status: 502,
    });
  });
});

describe("problemTerminalUrl", () => {
  it("should map an https apiBaseUrl to wss and append the ticket", () => {
    expect(problemTerminalUrl("https://api.example.com", "p1", "tik-1")).toBe(
      "wss://api.example.com/portal/me/problems/p1/terminal?ticket=tik-1",
    );
  });

  it("should map an http apiBaseUrl (local-play loopback) to ws", () => {
    expect(problemTerminalUrl("http://127.0.0.1:3199", "p1", "tik-1")).toBe(
      "ws://127.0.0.1:3199/portal/me/problems/p1/terminal?ticket=tik-1",
    );
  });

  it("should encode the problemId and accept a trailing apiBaseUrl slash", () => {
    expect(problemTerminalUrl("https://api.example.com/", "sha256/level-1", "tik")).toBe(
      "wss://api.example.com/portal/me/problems/sha256%2Flevel-1/terminal?ticket=tik",
    );
  });
});
