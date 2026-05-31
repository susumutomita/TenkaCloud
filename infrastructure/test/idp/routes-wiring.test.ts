import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdpHandlerDeps, IdpScope } from "../../lib/control-plane/handlers/idp-handler/core";

/**
 * Issue #1418: idp-handler/routes.ts (buildIdpApp) は 66% branch だった。 既存 routes.test の
 * happy path に加え、 forbidden short-circuit (全 route)、 invalid_idp_id、 onError、 safeJson の
 * parse 失敗、 mapError の全 kind (validation / invalid_metadata / not_found / conflict / internal)
 * を pin する。 auth.resolveCognitoSub は mock、 core deps は fake、 resolveScope は toggle 可能。
 */
vi.mock("../../lib/control-plane/handlers/idp-handler/auth", () => ({
  resolveCognitoSub: () => "sub-1",
}));

const { buildIdpApp } = await import("../../lib/control-plane/handlers/idp-handler/routes");

const VALID_METADATA = `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="http://idp.test/entity">
  <md:IDPSSODescriptor>
    <md:KeyDescriptor><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>B</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
const config = {
  idpId: "okta-acme",
  displayName: "Acme",
  metadataXml: VALID_METADATA,
  attributeMapping: { email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress" },
  groupToRole: { admins: "TenantAdmin" },
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
};
const validBody = {
  idpId: "new-idp",
  displayName: "New",
  metadataXml: VALID_METADATA,
  attributeMapping: { email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress" },
  groupToRole: { admins: "TenantAdmin" },
};

const cfg: {
  scopeMode: "system" | "forbidden" | "throw";
  existing: typeof config | null;
  cognitoThrow: unknown;
} = { scopeMode: "system", existing: null, cognitoThrow: undefined };

const resolveScope = (c: Context): IdpScope | { readonly forbidden: Response } => {
  if (cfg.scopeMode === "throw") throw new Error("scope boom");
  if (cfg.scopeMode === "forbidden")
    return { forbidden: c.json({ error: "forbidden" }, StatusCodes.FORBIDDEN) };
  return { kind: "system" };
};
const deps = {
  store: {
    get: vi.fn(async () => cfg.existing),
    list: vi.fn(async () => (cfg.existing ? [cfg.existing] : [])),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  },
  cognito: {
    createIdp: vi.fn(async () => {
      if (cfg.cognitoThrow) throw cfg.cognitoThrow;
    }),
    updateIdp: vi.fn(async () => {
      if (cfg.cognitoThrow) throw cfg.cognitoThrow;
    }),
    deleteIdp: vi.fn(async () => {
      if (cfg.cognitoThrow) throw cfg.cognitoThrow;
    }),
  },
  now: () => new Date("2026-05-24T00:00:00.000Z"),
} as unknown as IdpHandlerDeps;
const app = buildIdpApp({ resolveScope, pathPrefix: "/admin/idp", deps });

const json = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  cfg.scopeMode = "system";
  cfg.existing = null;
  cfg.cognitoThrow = undefined;
});
afterEach(() => vi.clearAllMocks());

describe("buildIdpApp wiring", () => {
  it("should serve healthz", async () => {
    expect((await app.request("/admin/idp/healthz")).status).toBe(StatusCodes.OK);
  });

  it.each([
    ["GET", "/admin/idp"],
    ["GET", "/admin/idp/okta-acme"],
    ["POST", "/admin/idp"],
    ["PATCH", "/admin/idp/okta-acme"],
    ["DELETE", "/admin/idp/okta-acme"],
  ])("should 403 %s %s when the scope resolver forbids", async (method, path) => {
    cfg.scopeMode = "forbidden";
    expect((await json(method, path)).status).toBe(StatusCodes.FORBIDDEN);
  });

  it("should 500 via onError when the scope resolver throws", async () => {
    cfg.scopeMode = "throw";
    const res = await app.request("/admin/idp");
    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    expect((await res.json()).error).toBe("internal_error");
  });
});

describe("GET list / GET one", () => {
  it("should list idps with metadataXml stripped", async () => {
    cfg.existing = config;
    const res = await app.request("/admin/idp");
    expect(res.status).toBe(StatusCodes.OK);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).not.toHaveProperty("metadataXml");
    expect(body.items[0]).toMatchObject({ idpId: "okta-acme" });
  });
  it("should 400 on an invalid idpId", async () => {
    expect((await app.request("/admin/idp/Bad%20ID!")).status).toBe(StatusCodes.BAD_REQUEST);
  });
  it("should 404 when the idp does not exist", async () => {
    cfg.existing = null;
    expect((await app.request("/admin/idp/okta-acme")).status).toBe(StatusCodes.NOT_FOUND);
  });
  it("should 200 with the full config on hit", async () => {
    cfg.existing = config;
    const res = await app.request("/admin/idp/okta-acme");
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toMatchObject({ idpId: "okta-acme", metadataXml: VALID_METADATA });
  });
});

describe("POST create + mapError kinds", () => {
  it("should 201 on success", async () => {
    const res = await json("POST", "/admin/idp", validBody);
    expect(res.status).toBe(StatusCodes.CREATED);
  });
  it("should 400 validation_failed on an unparseable body (safeJson → null)", async () => {
    const res = await app.request("/admin/idp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("validation_failed");
  });
  it("should 400 invalid_metadata on bad metadata", async () => {
    const res = await json("POST", "/admin/idp", {
      ...validBody,
      metadataXml: VALID_METADATA.replace(/IDPSSODescriptor/g, "SPSSODescriptor"),
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("invalid_metadata");
  });
  it("should 409 conflict when the idp already exists", async () => {
    cfg.existing = config;
    const res = await json("POST", "/admin/idp", { ...validBody, idpId: "okta-acme" });
    expect(res.status).toBe(StatusCodes.CONFLICT);
  });
  it("should 500 internal_error when Cognito create fails", async () => {
    cfg.cognitoThrow = new Error("cognito down");
    const res = await json("POST", "/admin/idp", validBody);
    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
  });
});

describe("PATCH update", () => {
  it("should 400 on an invalid idpId", async () => {
    expect((await json("PATCH", "/admin/idp/Bad%20ID!", {})).status).toBe(StatusCodes.BAD_REQUEST);
  });
  it("should 404 (mapError not_found) when the idp is absent", async () => {
    cfg.existing = null;
    expect((await json("PATCH", "/admin/idp/okta-acme", { displayName: "X" })).status).toBe(
      StatusCodes.NOT_FOUND,
    );
  });
  it("should 200 on success", async () => {
    cfg.existing = config;
    expect((await json("PATCH", "/admin/idp/okta-acme", { displayName: "Renamed" })).status).toBe(
      StatusCodes.OK,
    );
  });
});

describe("DELETE", () => {
  it("should 400 on an invalid idpId", async () => {
    expect((await json("DELETE", "/admin/idp/Bad%20ID!")).status).toBe(StatusCodes.BAD_REQUEST);
  });
  it("should 404 when the idp is absent", async () => {
    cfg.existing = null;
    expect((await json("DELETE", "/admin/idp/okta-acme")).status).toBe(StatusCodes.NOT_FOUND);
  });
  it("should 204 on success", async () => {
    cfg.existing = config;
    expect((await json("DELETE", "/admin/idp/okta-acme")).status).toBe(StatusCodes.NO_CONTENT);
  });
});
