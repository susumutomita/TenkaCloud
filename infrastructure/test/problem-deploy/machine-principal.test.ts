import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { extractAuditContext } from "../../lib/problem-deploy/handlers/shared/audit-log";
import {
  isHumanClaims,
  parseMachinePrincipal,
} from "../../lib/problem-deploy/handlers/shared/machine-principal";
import {
  bindScope,
  capabilityScope,
  findMachineRoute,
  MACHINE_CAPABILITIES,
  MACHINE_ROUTE_SCOPES,
  matchesHonoPath,
} from "../../lib/problem-deploy/handlers/shared/machine-scopes";

/**
 * Issue #2948: machine principal の解析規則。
 *
 * ここで pin するのは「どんな claim が machine principal になるか」だけであり、route guard の
 * 振る舞いは `machine-route-guard.test.ts` が持つ。fail-closed の matrix (bind scope 0 件 /
 * 2 件 / capability 0 件 / `client_id` 不在 / ID token) を全部 `undefined` に倒すことが中核。
 */

const TENANT = "01JABCDEF0123456789ABCDEF";

function machineClaims(overrides: Record<string, unknown> = {}) {
  return {
    token_use: "access",
    client_id: "machine-client-1",
    scope: `${capabilityScope("read")} ${bindScope(TENANT)}`,
    ...overrides,
  } as Record<string, string>;
}

describe("parseMachinePrincipal (#2948 T-1 / T-2)", () => {
  it("should resolve tenantId, capabilities and clientId from a well-formed access token", () => {
    const principal = parseMachinePrincipal(machineClaims());
    expect(principal?.tenantId).toBe(TENANT);
    expect(principal?.clientId).toBe("machine-client-1");
    expect([...(principal?.capabilities ?? [])]).toEqual(["read"]);
  });

  it("should resolve every declared capability when the token carries all of them", () => {
    const scope = `${MACHINE_CAPABILITIES.map(capabilityScope).join(" ")} ${bindScope(TENANT)}`;
    const principal = parseMachinePrincipal(machineClaims({ scope }));
    expect([...(principal?.capabilities ?? [])].sort()).toEqual([...MACHINE_CAPABILITIES].sort());
  });

  it.each([
    ["scope claim が無い", { scope: undefined }],
    ["scope claim が空", { scope: "   " }],
    ["bind scope が 0 件", { scope: capabilityScope("read") }],
    [
      "bind scope が 2 件 (= どちらの tenant か決められない)",
      { scope: `${capabilityScope("read")} ${bindScope(TENANT)} ${bindScope("other-tenant")}` },
    ],
    ["capability scope が 0 件 (= bind only)", { scope: bindScope(TENANT) }],
    ["認識できない capability しか無い", { scope: `tenkacloud/ops.unknown ${bindScope(TENANT)}` }],
    ["client_id が無い", { client_id: undefined }],
    ["token_use が access でない (= ID token)", { token_use: "id" }],
    ["token_use が無い", { token_use: undefined }],
  ])("should return undefined when %s (fail-closed)", (_label, overrides) => {
    const claims = machineClaims(overrides as Record<string, unknown>);
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete claims[key];
    }
    expect(parseMachinePrincipal(claims)).toBeUndefined();
  });

  it("should return undefined for a human ID token even when it also carries machine scopes", () => {
    const claims = machineClaims({ "custom:tenantId": "human-tenant" });
    expect(isHumanClaims(claims)).toBe(true);
    expect(parseMachinePrincipal(claims)).toBeUndefined();
  });

  it("should return undefined when claims are absent entirely", () => {
    expect(parseMachinePrincipal(undefined)).toBeUndefined();
    expect(isHumanClaims(undefined)).toBe(false);
  });

  it("should refuse a bind scope whose tenant segment contains a path separator", () => {
    const claims = machineClaims({
      scope: `${capabilityScope("read")} tc-tenant-a/b/bind`,
    });
    expect(parseMachinePrincipal(claims)).toBeUndefined();
  });
});

describe("machine route matcher (#2948 T-9 parity)", () => {
  it("should match every allowlisted route against a concrete request path", () => {
    for (const route of MACHINE_ROUTE_SCOPES) {
      const concrete = route.honoPath
        .split("/")
        .map((segment) => (segment.startsWith(":") ? "01JCONCRETE0000000000000" : segment))
        .join("/");
      expect(findMachineRoute(route.method, concrete)).toEqual(route);
    }
  });

  it.each([
    ["trailing slash", "GET", "/deployments/"],
    ["double slash", "GET", "//deployments"],
    ["extra segment", "GET", "/deployments/x/y"],
    ["prefix of an allowlisted path", "GET", "/events/x/disruptions"],
    ["wrong method", "POST", "/deployments"],
    ["empty param segment", "GET", "/problems//deployments"],
  ])("should not match a near-miss (%s)", (_label, method, path) => {
    expect(findMachineRoute(method, path)).toBeUndefined();
  });

  it("should treat a param segment as exactly one non-empty segment", () => {
    expect(matchesHonoPath("/deployments/:jobId", "/deployments/abc")).toBe(true);
    expect(matchesHonoPath("/deployments/:jobId", "/deployments/")).toBe(false);
    expect(matchesHonoPath("/deployments/:jobId", "/deployments/a/b")).toBe(false);
  });

  it("should agree with Hono's own dispatch for every allowlisted route and near-miss", async () => {
    // shim (= guard の自前 matcher) と Hono の dispatch が一致することの機械的な証明。
    // Hono の `use("*")` 内では `c.req.routePath` が middleware 自身の path を返すため
    // guard は自前 matcher を持たざるを得ず、その drift をここで検出する。
    const app = new Hono();
    for (const route of MACHINE_ROUTE_SCOPES) {
      app.on(route.method, route.honoPath, (c) => c.json({ matched: route.honoPath }));
    }
    app.all("*", (c) => c.json({ matched: null }, 404));

    const probes: ReadonlyArray<{ method: string; path: string }> = [
      ...MACHINE_ROUTE_SCOPES.map((route) => ({
        method: route.method,
        path: route.honoPath
          .split("/")
          .map((segment) => (segment.startsWith(":") ? "concrete" : segment))
          .join("/"),
      })),
      { method: "GET", path: "/deployments/" },
      { method: "GET", path: "/deployments/x/y" },
      { method: "GET", path: "/events/x/disruptions" },
      { method: "POST", path: "/deployments" },
      { method: "DELETE", path: "/deployments/abc" },
    ];

    for (const probe of probes) {
      const res = await app.request(probe.path, { method: probe.method });
      const body = (await res.json()) as { matched: string | null };
      const shim = findMachineRoute(probe.method, probe.path);
      expect(shim?.honoPath ?? null, `${probe.method} ${probe.path}`).toBe(body.matched);
    }
  });
});

describe("extractAuditContext with a machine token (#2948 T-10)", () => {
  function contextWithClaims(claims: Record<string, string>) {
    return {
      env: {
        event: {
          requestContext: {
            authorizer: { claims },
            identity: { sourceIp: "203.0.113.7", userAgent: "tcloud/1.0" },
          },
        },
      },
    };
  }

  it("should set actor to m2m:<client_id> and drop actorUsername", () => {
    const ctx = extractAuditContext(contextWithClaims(machineClaims()));
    expect(ctx.actor).toBe("m2m:machine-client-1");
    expect(ctx.actorUsername).toBeUndefined();
    expect(ctx.ipAddress).toBe("203.0.113.7");
  });

  it("should fall back to m2m:unknown (never a bare unknown) when client_id is missing", () => {
    const claims = machineClaims();
    delete (claims as Record<string, string | undefined>).client_id;
    expect(extractAuditContext(contextWithClaims(claims)).actor).toBe("m2m:unknown");
  });

  it("should leave the human path completely unchanged", () => {
    const ctx = extractAuditContext(
      contextWithClaims({
        sub: "cognito-sub-1",
        "cognito:username": "operator@example.com",
        "custom:tenantId": "tenant-1",
      }),
    );
    expect(ctx.actor).toBe("cognito-sub-1");
    expect(ctx.actorUsername).toBe("operator@example.com");
  });
});
