import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditApi } from "../src/api/audit.ts";
import { DeployApi } from "../src/api/deploy.ts";
import { EventsApi } from "../src/api/events.ts";
import { IdpApi } from "../src/api/idp.ts";
import { ScoreboardApi } from "../src/api/scoreboard.ts";
import { TenantsApi } from "../src/api/tenants.ts";
import { saveTokens } from "../src/credential-store.ts";
import type { FetchAuthConfig } from "../src/http/fetch-with-auth.ts";

/**
 * Unit tests for every `src/api/*.ts` client. They exercise the happy path
 * (request method / path / body) and every response-shape branch
 * (array / `data` / named-collection / empty fallback) plus optional query
 * params, by injecting `fetchImpl` and backing it with the real credential
 * store under a throwaway HOME.
 */

const BASE = "https://api.example.com";
const AUTH_DOMAIN = "https://auth.example.com";

let originalHome: string | undefined;
let tempDir: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempDir = mkdtempSync(join(tmpdir(), "cli-api-"));
  process.env.HOME = tempDir;
  saveTokens({
    accessToken: "bearer-api",
    idToken: "id-api",
    refreshToken: "rt-api",
    expiresAt: Math.floor(Date.now() / 1000) + 10000,
    issuer: "https://cognito-idp.local/userpool",
    clientId: "client-api",
  });
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tempDir, { recursive: true, force: true });
});

/** Build a fetch mock that returns a JSON body with status 200. */
function jsonFetch(body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
}

/** A fetch mock that returns a non-JSON text body (string passthrough). */
function textFetch(text: string) {
  return vi.fn(async () => new Response(text, { status: 200 }));
}

function auth(fetchImpl: ReturnType<typeof jsonFetch>): FetchAuthConfig {
  return { hostedUiDomain: AUTH_DOMAIN, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function calledUrl(fetchImpl: ReturnType<typeof jsonFetch>): string {
  return String(fetchImpl.mock.calls[0]?.[0]);
}

function calledInit(fetchImpl: ReturnType<typeof jsonFetch>): RequestInit {
  return fetchImpl.mock.calls[0]?.[1] as RequestInit;
}

describe("AuditApi", () => {
  it("should GET /audit with no query params when query is omitted", async () => {
    const fetchImpl = jsonFetch({ data: [] });
    const api = new AuditApi(BASE, auth(fetchImpl));
    await api.query();
    expect(calledUrl(fetchImpl)).toBe("https://api.example.com/audit");
    expect(calledInit(fetchImpl).method).toBe("GET");
  });

  it("should pass all provided query params to /audit", async () => {
    const fetchImpl = jsonFetch({ data: [] });
    const api = new AuditApi(BASE, auth(fetchImpl));
    await api.query({
      from: "2026-01-01",
      to: "2026-01-02",
      principal: "alice",
      action: "login",
    });
    const url = new URL(calledUrl(fetchImpl));
    expect(url.pathname).toBe("/audit");
    expect(url.searchParams.get("from")).toBe("2026-01-01");
    expect(url.searchParams.get("to")).toBe("2026-01-02");
    expect(url.searchParams.get("principal")).toBe("alice");
    expect(url.searchParams.get("action")).toBe("login");
  });

  it("should omit undefined query params from the /audit URL", async () => {
    const fetchImpl = jsonFetch({ data: [] });
    const api = new AuditApi(BASE, auth(fetchImpl));
    await api.query({ principal: "bob" });
    const url = new URL(calledUrl(fetchImpl));
    expect(url.searchParams.get("principal")).toBe("bob");
    expect(url.searchParams.has("from")).toBe(false);
    expect(url.searchParams.has("to")).toBe(false);
    expect(url.searchParams.has("action")).toBe(false);
  });

  it("should return a bare array response unchanged", async () => {
    const rows = [{ timestamp: "t", principal: "p", action: "a" }];
    const api = new AuditApi(BASE, auth(jsonFetch(rows)));
    expect(await api.query()).toEqual(rows);
  });

  it("should unwrap the data property", async () => {
    const rows = [{ timestamp: "t", principal: "p", action: "a" }];
    const api = new AuditApi(BASE, auth(jsonFetch({ data: rows })));
    expect(await api.query()).toEqual(rows);
  });

  it("should fall back to the entries property when data is absent", async () => {
    const rows = [{ timestamp: "t", principal: "p", action: "a" }];
    const api = new AuditApi(BASE, auth(jsonFetch({ entries: rows })));
    expect(await api.query()).toEqual(rows);
  });

  it("should return an empty array when neither data nor entries is present", async () => {
    const api = new AuditApi(BASE, auth(jsonFetch({})));
    expect(await api.query()).toEqual([]);
  });

  it("should return an empty array when the response is empty (undefined)", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const api = new AuditApi(BASE, { hostedUiDomain: AUTH_DOMAIN, fetchImpl: fetchImpl as never });
    expect(await api.query()).toEqual([]);
  });
});

describe("DeployApi", () => {
  it("should POST /deployments with eventId/teamId/problemId body and return the summary", async () => {
    const summary = { deploymentId: "d1", status: "PENDING" };
    const fetchImpl = jsonFetch(summary);
    const api = new DeployApi(BASE, auth(fetchImpl));
    const result = await api.deploy("e1", "t1", "p1");
    expect(result).toEqual(summary);
    expect(calledUrl(fetchImpl)).toBe("https://api.example.com/deployments");
    const init = calledInit(fetchImpl);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      eventId: "e1",
      teamId: "t1",
      problemId: "p1",
    });
  });

  it("should POST /deployments/bulk and unwrap a data array", async () => {
    const rows = [{ deploymentId: "d1" }, { deploymentId: "d2" }];
    const fetchImpl = jsonFetch({ data: rows });
    const api = new DeployApi(BASE, auth(fetchImpl));
    const result = await api.bulkDeploy("e1");
    expect(result).toEqual(rows);
    expect(calledUrl(fetchImpl)).toBe("https://api.example.com/deployments/bulk");
    expect(JSON.parse(calledInit(fetchImpl).body as string)).toEqual({ eventId: "e1" });
  });

  it("should return a bare array bulkDeploy response unchanged", async () => {
    const rows = [{ deploymentId: "d1" }];
    const api = new DeployApi(BASE, auth(jsonFetch(rows)));
    expect(await api.bulkDeploy("e1")).toEqual(rows);
  });

  it("should return an empty array when bulkDeploy data is absent", async () => {
    const api = new DeployApi(BASE, auth(jsonFetch({})));
    expect(await api.bulkDeploy("e1")).toEqual([]);
  });

  it("should GET /deployments/<id> with an encoded id for status", async () => {
    const summary = { deploymentId: "d/1", status: "DONE" };
    const fetchImpl = jsonFetch(summary);
    const api = new DeployApi(BASE, auth(fetchImpl));
    const result = await api.status("d/1");
    expect(result).toEqual(summary);
    expect(calledUrl(fetchImpl)).toBe("https://api.example.com/deployments/d%2F1");
    expect(calledInit(fetchImpl).method).toBe("GET");
  });

  it("should GET /deployments/<id>/logs and unwrap a data array", async () => {
    const logs = [{ timestamp: "t", message: "m" }];
    const fetchImpl = jsonFetch({ data: logs });
    const api = new DeployApi(BASE, auth(fetchImpl));
    const result = await api.logs("d1");
    expect(result).toEqual(logs);
    expect(calledUrl(fetchImpl)).toBe("https://api.example.com/deployments/d1/logs");
  });

  it("should fall back to the logs property when data is absent", async () => {
    const logs = [{ timestamp: "t", message: "m" }];
    const api = new DeployApi(BASE, auth(jsonFetch({ logs })));
    expect(await api.logs("d1")).toEqual(logs);
  });

  it("should return a bare array logs response unchanged", async () => {
    const logs = [{ timestamp: "t", message: "m" }];
    const api = new DeployApi(BASE, auth(jsonFetch(logs)));
    expect(await api.logs("d1")).toEqual(logs);
  });

  it("should return an empty array when neither logs data nor logs is present", async () => {
    const api = new DeployApi(BASE, auth(jsonFetch({})));
    expect(await api.logs("d1")).toEqual([]);
  });
});

describe("EventsApi", () => {
  it("should GET /events with no query when status is omitted", async () => {
    const fetchImpl = jsonFetch({ data: [] });
    const api = new EventsApi(BASE, auth(fetchImpl));
    await api.list();
    expect(calledUrl(fetchImpl)).toBe("https://api.example.com/events");
  });

  it("should GET /events with a status query when status is given", async () => {
    const fetchImpl = jsonFetch({ data: [] });
    const api = new EventsApi(BASE, auth(fetchImpl));
    await api.list("RUNNING");
    expect(calledUrl(fetchImpl)).toBe("https://api.example.com/events?status=RUNNING");
  });

  it("should return a bare array list response unchanged", async () => {
    const rows = [{ eventId: "e1" }];
    const api = new EventsApi(BASE, auth(jsonFetch(rows)));
    expect(await api.list()).toEqual(rows);
  });

  it("should unwrap the data property for list", async () => {
    const rows = [{ eventId: "e1" }];
    const api = new EventsApi(BASE, auth(jsonFetch({ data: rows })));
    expect(await api.list()).toEqual(rows);
  });

  it("should fall back to the events property when data is absent", async () => {
    const rows = [{ eventId: "e1" }];
    const api = new EventsApi(BASE, auth(jsonFetch({ events: rows })));
    expect(await api.list()).toEqual(rows);
  });

  it("should return an empty array when neither data nor events is present", async () => {
    const api = new EventsApi(BASE, auth(jsonFetch({})));
    expect(await api.list()).toEqual([]);
  });

  it("should GET /events/<id> with an encoded id for get", async () => {
    const summary = { eventId: "e 1", name: "Cup" };
    const fetchImpl = jsonFetch(summary);
    const api = new EventsApi(BASE, auth(fetchImpl));
    expect(await api.get("e 1")).toEqual(summary);
    expect(calledUrl(fetchImpl)).toBe("https://api.example.com/events/e%201");
  });

  it("should POST /events with the create input as the body", async () => {
    const input = {
      name: "Cup",
      start: "2026-01-01T00:00Z",
      end: "2026-01-01T05:00Z",
      problemset: "ps-1",
    };
    const fetchImpl = jsonFetch({ eventId: "e1" });
    const api = new EventsApi(BASE, auth(fetchImpl));
    const result = await api.create(input);
    expect(result).toEqual({ eventId: "e1" });
    expect(calledUrl(fetchImpl)).toBe("https://api.example.com/events");
    const init = calledInit(fetchImpl);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(input);
  });

  it("should POST /events/<id>/end", async () => {
    const fetchImpl = jsonFetch({ eventId: "e1", status: "ENDED" });
    const api = new EventsApi(BASE, auth(fetchImpl));
    await api.end("e1");
    expect(calledUrl(fetchImpl)).toBe("https://api.example.com/events/e1/end");
    expect(calledInit(fetchImpl).method).toBe("POST");
  });

  it("should POST /events/<id>/archive", async () => {
    const fetchImpl = jsonFetch({ eventId: "e1", status: "ARCHIVED" });
    const api = new EventsApi(BASE, auth(fetchImpl));
    await api.archive("e1");
    expect(calledUrl(fetchImpl)).toBe("https://api.example.com/events/e1/archive");
    expect(calledInit(fetchImpl).method).toBe("POST");
  });

  it("should wrap a plain-string report body into a markdown object", async () => {
    const fetchImpl = textFetch("# Report\nbody");
    const api = new EventsApi(BASE, {
      hostedUiDomain: AUTH_DOMAIN,
      fetchImpl: fetchImpl as never,
    });
    const result = await api.report("e1");
    expect(result).toEqual({ markdown: "# Report\nbody" });
    expect(calledUrl(fetchImpl as never)).toBe("https://api.example.com/events/e1/report");
  });

  it("should pass a JSON report object through unchanged", async () => {
    const report = { markdown: "# Report" };
    const api = new EventsApi(BASE, auth(jsonFetch(report)));
    expect(await api.report("e1")).toEqual(report);
  });
});

describe("IdpApi", () => {
  it("should GET /idp and unwrap a data array", async () => {
    const rows = [{ idpId: "i1" }];
    const fetchImpl = jsonFetch({ data: rows });
    const api = new IdpApi(BASE, auth(fetchImpl));
    expect(await api.list()).toEqual(rows);
    expect(calledUrl(fetchImpl)).toBe("https://api.example.com/idp");
  });

  it("should return a bare array list response unchanged", async () => {
    const rows = [{ idpId: "i1" }];
    const api = new IdpApi(BASE, auth(jsonFetch(rows)));
    expect(await api.list()).toEqual(rows);
  });

  it("should fall back to the idps property when data is absent", async () => {
    const rows = [{ idpId: "i1" }];
    const api = new IdpApi(BASE, auth(jsonFetch({ idps: rows })));
    expect(await api.list()).toEqual(rows);
  });

  it("should return an empty array when neither data nor idps is present", async () => {
    const api = new IdpApi(BASE, auth(jsonFetch({})));
    expect(await api.list()).toEqual([]);
  });

  it("should POST /idp with the create input as the body", async () => {
    const input = { name: "Okta", metadataUrl: "https://meta" };
    const fetchImpl = jsonFetch({ idpId: "i1" });
    const api = new IdpApi(BASE, auth(fetchImpl));
    const result = await api.create(input);
    expect(result).toEqual({ idpId: "i1" });
    expect(calledUrl(fetchImpl)).toBe("https://api.example.com/idp");
    const init = calledInit(fetchImpl);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(input);
  });

  it("should PATCH /idp/<id> with an encoded id and the update body", async () => {
    const fetchImpl = jsonFetch({ idpId: "i 1" });
    const api = new IdpApi(BASE, auth(fetchImpl));
    const result = await api.update("i 1", { metadataUrl: "https://meta2" });
    expect(result).toEqual({ idpId: "i 1" });
    expect(calledUrl(fetchImpl)).toBe("https://api.example.com/idp/i%201");
    const init = calledInit(fetchImpl);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ metadataUrl: "https://meta2" });
  });

  it("should DELETE /idp/<id> and resolve to void", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const api = new IdpApi(BASE, { hostedUiDomain: AUTH_DOMAIN, fetchImpl: fetchImpl as never });
    const result = await api.delete("i1");
    expect(result).toBeUndefined();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://api.example.com/idp/i1");
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).method).toBe("DELETE");
  });
});

describe("ScoreboardApi", () => {
  it("should GET /events/<id>/scoreboard with an encoded id and unwrap data", async () => {
    const rows = [{ teamId: "t1", score: 10 }];
    const fetchImpl = jsonFetch({ data: rows });
    const api = new ScoreboardApi(BASE, auth(fetchImpl));
    expect(await api.scoreboard("e 1")).toEqual(rows);
    expect(calledUrl(fetchImpl)).toBe("https://api.example.com/events/e%201/scoreboard");
  });

  it("should return a bare array scoreboard response unchanged", async () => {
    const rows = [{ teamId: "t1", score: 10 }];
    const api = new ScoreboardApi(BASE, auth(jsonFetch(rows)));
    expect(await api.scoreboard("e1")).toEqual(rows);
  });

  it("should fall back to the rows property when data is absent", async () => {
    const rows = [{ teamId: "t1", score: 10 }];
    const api = new ScoreboardApi(BASE, auth(jsonFetch({ rows })));
    expect(await api.scoreboard("e1")).toEqual(rows);
  });

  it("should return an empty array when neither data nor rows is present", async () => {
    const api = new ScoreboardApi(BASE, auth(jsonFetch({})));
    expect(await api.scoreboard("e1")).toEqual([]);
  });

  it("should GET /events/<id>/score-events with no query params when query is omitted", async () => {
    const fetchImpl = jsonFetch({ data: [] });
    const api = new ScoreboardApi(BASE, auth(fetchImpl));
    await api.scoreEvents("e1");
    expect(calledUrl(fetchImpl)).toBe("https://api.example.com/events/e1/score-events");
  });

  it("should pass all provided score-events query params", async () => {
    const fetchImpl = jsonFetch({ data: [] });
    const api = new ScoreboardApi(BASE, auth(fetchImpl));
    await api.scoreEvents("e1", { team: "t1", from: "2026-01-01", to: "2026-01-02" });
    const url = new URL(calledUrl(fetchImpl));
    expect(url.pathname).toBe("/events/e1/score-events");
    expect(url.searchParams.get("team")).toBe("t1");
    expect(url.searchParams.get("from")).toBe("2026-01-01");
    expect(url.searchParams.get("to")).toBe("2026-01-02");
  });

  it("should omit undefined score-events query params", async () => {
    const fetchImpl = jsonFetch({ data: [] });
    const api = new ScoreboardApi(BASE, auth(fetchImpl));
    await api.scoreEvents("e1", { team: "t1" });
    const url = new URL(calledUrl(fetchImpl));
    expect(url.searchParams.get("team")).toBe("t1");
    expect(url.searchParams.has("from")).toBe(false);
    expect(url.searchParams.has("to")).toBe(false);
  });

  it("should return a bare array score-events response unchanged", async () => {
    const rows = [{ eventTime: "t", teamId: "t1" }];
    const api = new ScoreboardApi(BASE, auth(jsonFetch(rows)));
    expect(await api.scoreEvents("e1")).toEqual(rows);
  });

  it("should unwrap the data property for score-events", async () => {
    const rows = [{ eventTime: "t", teamId: "t1" }];
    const api = new ScoreboardApi(BASE, auth(jsonFetch({ data: rows })));
    expect(await api.scoreEvents("e1")).toEqual(rows);
  });

  it("should fall back to the events property when data is absent", async () => {
    const rows = [{ eventTime: "t", teamId: "t1" }];
    const api = new ScoreboardApi(BASE, auth(jsonFetch({ events: rows })));
    expect(await api.scoreEvents("e1")).toEqual(rows);
  });

  it("should return an empty array when neither data nor events is present", async () => {
    const api = new ScoreboardApi(BASE, auth(jsonFetch({})));
    expect(await api.scoreEvents("e1")).toEqual([]);
  });
});

describe("TenantsApi", () => {
  it("should GET /tenants and unwrap a data array", async () => {
    const rows = [{ tenantId: "t1" }];
    const fetchImpl = jsonFetch({ data: rows });
    const api = new TenantsApi(BASE, auth(fetchImpl));
    expect(await api.list()).toEqual(rows);
    expect(calledUrl(fetchImpl)).toBe("https://api.example.com/tenants");
  });

  it("should return a bare array list response unchanged", async () => {
    const rows = [{ tenantId: "t1" }];
    const api = new TenantsApi(BASE, auth(jsonFetch(rows)));
    expect(await api.list()).toEqual(rows);
  });

  it("should fall back to the tenants property when data is absent", async () => {
    const rows = [{ tenantId: "t1" }];
    const api = new TenantsApi(BASE, auth(jsonFetch({ tenants: rows })));
    expect(await api.list()).toEqual(rows);
  });

  it("should return an empty array when neither data nor tenants is present", async () => {
    const api = new TenantsApi(BASE, auth(jsonFetch({})));
    expect(await api.list()).toEqual([]);
  });

  it("should GET /tenants/<id> with an encoded id for get", async () => {
    const summary = { tenantId: "t 1", tenantName: "Acme" };
    const fetchImpl = jsonFetch(summary);
    const api = new TenantsApi(BASE, auth(fetchImpl));
    expect(await api.get("t 1")).toEqual(summary);
    expect(calledUrl(fetchImpl)).toBe("https://api.example.com/tenants/t%201");
  });

  it("should POST /tenants with the create input as the body", async () => {
    const input = { tenantName: "Acme", tier: "BASIC", email: "a@example.com" };
    const fetchImpl = jsonFetch({ tenantId: "t1" });
    const api = new TenantsApi(BASE, auth(fetchImpl));
    const result = await api.create(input);
    expect(result).toEqual({ tenantId: "t1" });
    expect(calledUrl(fetchImpl)).toBe("https://api.example.com/tenants");
    const init = calledInit(fetchImpl);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(input);
  });

  it("should DELETE /tenants/<id> and resolve to void", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const api = new TenantsApi(BASE, {
      hostedUiDomain: AUTH_DOMAIN,
      fetchImpl: fetchImpl as never,
    });
    const result = await api.delete("t1");
    expect(result).toBeUndefined();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://api.example.com/tenants/t1");
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).method).toBe("DELETE");
  });
});
