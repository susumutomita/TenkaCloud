import type { SamlIdpConfig } from "@tenkacloud/saml-utils";
import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import type {
  CognitoIdpAdapter,
  IdpScope,
  IdpStore,
} from "../../lib/control-plane/handlers/idp-handler/core";
import { buildIdpApp } from "../../lib/control-plane/handlers/idp-handler/routes";

const VALID_METADATA = `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="http://idp.test/entity">
  <md:IDPSSODescriptor>
    <md:KeyDescriptor><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>BASE64</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

const happyBody = {
  idpId: "okta-acme",
  displayName: "Acme Okta",
  metadataXml: VALID_METADATA,
  attributeMapping: {
    email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  },
  groupToRole: { admins: "TenantAdmin" },
};

function makeFakeStore(): IdpStore {
  const items = new Map<string, SamlIdpConfig>();
  const keyOf = (scope: IdpScope, idpId: string) =>
    `${scope.kind === "system" ? "SYSTEM" : scope.tenantId}#${idpId}`;
  return {
    async list(scope) {
      const prefix = scope.kind === "system" ? "SYSTEM#" : `${scope.tenantId}#`;
      return [...items.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    },
    async get(scope, idpId) {
      return items.get(keyOf(scope, idpId)) ?? null;
    },
    async put(scope, c) {
      items.set(keyOf(scope, c.idpId), c);
    },
    async delete(scope, idpId) {
      items.delete(keyOf(scope, idpId));
    },
  };
}

function makeFakeCognito(): CognitoIdpAdapter {
  return {
    async createIdp() {},
    async updateIdp() {},
    async deleteIdp() {},
  };
}

function buildApp(scope: IdpScope | "forbidden") {
  return buildIdpApp({
    pathPrefix: "/admin/idp",
    resolveScope: (c: Context) => {
      if (scope === "forbidden") {
        return { forbidden: c.json({ error: "forbidden" }, 403) };
      }
      return scope;
    },
    deps: {
      store: makeFakeStore(),
      cognito: makeFakeCognito(),
      now: () => new Date("2026-05-24T00:00:00.000Z"),
    },
  });
}

describe("IdP API routes", () => {
  it("should return 403 when the caller is not authorized", async () => {
    const app = buildApp("forbidden");
    const res = await app.request("/admin/idp", { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("should accept POST + return 201 + return the persisted config", async () => {
    const app = buildApp({ kind: "system" });
    const res = await app.request("/admin/idp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(happyBody),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as SamlIdpConfig;
    expect(body.idpId).toBe("okta-acme");
    expect(body.createdAt).toBe("2026-05-24T00:00:00.000Z");
  });

  it("should return 400 when body is missing required fields", async () => {
    const app = buildApp({ kind: "system" });
    const res = await app.request("/admin/idp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idpId: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("should return 400 for an invalid idpId in path params", async () => {
    const app = buildApp({ kind: "system" });
    const res = await app.request("/admin/idp/has%20space", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("should return 404 on GET for unknown idp", async () => {
    const app = buildApp({ kind: "system" });
    const res = await app.request("/admin/idp/missing");
    expect(res.status).toBe(404);
  });

  it("should strip metadataXml from the list response (no log/network bloat)", async () => {
    const app = buildApp({ kind: "system" });
    await app.request("/admin/idp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(happyBody),
    });
    const res = await app.request("/admin/idp");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].metadataXml).toBeUndefined();
    expect(body.items[0].displayName).toBe("Acme Okta");
  });

  it("should support full CRUD lifecycle (create → get → patch → delete → 404)", async () => {
    const app = buildApp({ kind: "system" });
    await app.request("/admin/idp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(happyBody),
    });
    const get1 = await app.request("/admin/idp/okta-acme");
    expect(get1.status).toBe(200);
    const patched = await app.request("/admin/idp/okta-acme", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Renamed Okta" }),
    });
    expect(patched.status).toBe(200);
    const deleted = await app.request("/admin/idp/okta-acme", { method: "DELETE" });
    expect(deleted.status).toBe(204);
    const get2 = await app.request("/admin/idp/okta-acme");
    expect(get2.status).toBe(404);
  });
});

describe("tenant isolation at the route layer", () => {
  it("should never return tenant B's IdPs through tenant A's scope", async () => {
    // One shared store, two apps each scoped to a different tenant.
    const sharedStore = makeFakeStore();
    const sharedCognito = makeFakeCognito();
    const aApp = buildIdpApp({
      pathPrefix: "/tenant/idp",
      resolveScope: () => ({ kind: "tenant", tenantId: "acme" }),
      deps: {
        store: sharedStore,
        cognito: sharedCognito,
        now: () => new Date("2026-05-24T00:00:00.000Z"),
      },
    });
    const bApp = buildIdpApp({
      pathPrefix: "/tenant/idp",
      resolveScope: () => ({ kind: "tenant", tenantId: "beta" }),
      deps: {
        store: sharedStore,
        cognito: sharedCognito,
        now: () => new Date("2026-05-24T00:00:00.000Z"),
      },
    });

    await aApp.request("/tenant/idp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...happyBody, idpId: "acme-okta" }),
    });
    await bApp.request("/tenant/idp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...happyBody, idpId: "beta-okta" }),
    });

    // Tenant A cannot fetch tenant B's idp by guessing the id.
    const cross = await aApp.request("/tenant/idp/beta-okta");
    expect(cross.status).toBe(404);
    // Tenant A's list only shows tenant A's idp.
    const listRes = await aApp.request("/tenant/idp");
    const listBody = (await listRes.json()) as { items: Array<{ idpId: string }> };
    expect(listBody.items.map((i) => i.idpId)).toEqual(["acme-okta"]);

    // Tenant A trying to delete tenant B's idp is a 404 (= isolation).
    const del = await aApp.request("/tenant/idp/beta-okta", { method: "DELETE" });
    expect(del.status).toBe(404);
  });
});
