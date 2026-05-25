import type { SamlIdpConfig } from "@tenkacloud/saml-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CognitoIdpAdapter,
  createIdp,
  deleteIdp,
  getIdp,
  type IdpHandlerDeps,
  type IdpScope,
  type IdpStore,
  listIdps,
  updateIdp,
} from "../../lib/control-plane/handlers/idp-handler/core";

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
  groupToRole: { admins: "TenantAdmin" } as const,
};

function makeFakeStore(): IdpStore & { _items: Map<string, SamlIdpConfig> } {
  const items = new Map<string, SamlIdpConfig>();
  const keyOf = (scope: IdpScope, idpId: string) =>
    `${scope.kind === "system" ? "SYSTEM" : scope.tenantId}#${idpId}`;
  return {
    _items: items,
    async list(scope) {
      const prefix = scope.kind === "system" ? "SYSTEM#" : `${scope.tenantId}#`;
      return [...items.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    },
    async get(scope, idpId) {
      return items.get(keyOf(scope, idpId)) ?? null;
    },
    async put(scope, config) {
      items.set(keyOf(scope, config.idpId), config);
    },
    async delete(scope, idpId) {
      items.delete(keyOf(scope, idpId));
    },
  };
}

function makeFakeCognito(): CognitoIdpAdapter & {
  created: SamlIdpConfig[];
  updated: SamlIdpConfig[];
  deleted: string[];
} {
  return {
    created: [],
    updated: [],
    deleted: [],
    async createIdp(config) {
      this.created.push(config);
    },
    async updateIdp(config) {
      this.updated.push(config);
    },
    async deleteIdp(idpId) {
      this.deleted.push(idpId);
    },
  };
}

function makeDeps(): IdpHandlerDeps & {
  store: ReturnType<typeof makeFakeStore>;
  cognito: ReturnType<typeof makeFakeCognito>;
} {
  return {
    store: makeFakeStore(),
    cognito: makeFakeCognito(),
    now: () => new Date("2026-05-24T00:00:00.000Z"),
  };
}

describe("createIdp (Control Plane scope)", () => {
  const scope: IdpScope = { kind: "system" };

  it("should reject when the body fails schema validation", async () => {
    const deps = makeDeps();
    const res = await createIdp(deps, scope, { idpId: "x" }); // missing required fields
    expect("error" in res && res.error.kind).toBe("validation");
  });

  it("should reject when metadata XML is missing IDPSSODescriptor (= SP descriptor uploaded by mistake)", async () => {
    const deps = makeDeps();
    const badMeta = VALID_METADATA.replace(/IDPSSODescriptor/g, "SPSSODescriptor");
    const res = await createIdp(deps, scope, { ...happyBody, metadataXml: badMeta });
    expect("error" in res && res.error.kind).toBe("invalid_metadata");
  });

  it("should write Cognito then DDB on the happy path", async () => {
    const deps = makeDeps();
    const res = await createIdp(deps, scope, happyBody);
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.idpId).toBe("okta-acme");
    expect(res.tenantId).toBeUndefined();
    expect(deps.cognito.created).toHaveLength(1);
    expect(await deps.store.get(scope, "okta-acme")).not.toBeNull();
  });

  it("should NOT write DDB when Cognito.createIdp fails (= no ghost row)", async () => {
    const deps = makeDeps();
    deps.cognito.createIdp = vi.fn().mockRejectedValueOnce(new Error("InvalidParameter"));
    const res = await createIdp(deps, scope, happyBody);
    expect("error" in res && res.error.kind).toBe("internal");
    expect(await deps.store.get(scope, "okta-acme")).toBeNull();
  });

  it("should return conflict when idpId already exists", async () => {
    const deps = makeDeps();
    await createIdp(deps, scope, happyBody);
    const second = await createIdp(deps, scope, happyBody);
    expect("error" in second && second.error.kind).toBe("conflict");
  });
});

describe("createIdp (Application Plane scope)", () => {
  const scope: IdpScope = { kind: "tenant", tenantId: "acme" };

  it("should stamp tenantId onto the stored config", async () => {
    const deps = makeDeps();
    const res = await createIdp(deps, scope, happyBody);
    if ("error" in res) throw new Error("expected ok");
    expect(res.tenantId).toBe("acme");
  });

  it("should not collide between two tenants using the same idpId (=multi-tenant isolation)", async () => {
    const deps = makeDeps();
    await createIdp(deps, scope, happyBody);
    const other: IdpScope = { kind: "tenant", tenantId: "beta" };
    const res2 = await createIdp(deps, other, happyBody);
    expect("error" in res2).toBe(false);
    expect(await deps.store.get(scope, "okta-acme")).not.toBeNull();
    expect(await deps.store.get(other, "okta-acme")).not.toBeNull();
    // And tenant A cannot see tenant B's idp via its own scope (.list)
    const tenantAList = await listIdps(deps, scope);
    expect(tenantAList).toHaveLength(1);
    expect(tenantAList[0].tenantId).toBe("acme");
  });
});

describe("updateIdp", () => {
  const scope: IdpScope = { kind: "system" };

  it("should return not_found when the idpId does not exist", async () => {
    const deps = makeDeps();
    const res = await updateIdp(deps, scope, "missing", { displayName: "x" });
    expect("error" in res && res.error.kind).toBe("not_found");
  });

  it("should merge fields and bump updatedAt", async () => {
    const deps = makeDeps();
    await createIdp(deps, scope, happyBody);
    deps.now = () => new Date("2026-05-25T00:00:00.000Z");
    const res = await updateIdp(deps, scope, "okta-acme", { displayName: "Renamed" });
    if ("error" in res) throw new Error("expected ok");
    expect(res.displayName).toBe("Renamed");
    expect(res.updatedAt).toBe("2026-05-25T00:00:00.000Z");
    expect(deps.cognito.updated).toHaveLength(1);
  });
});

describe("deleteIdp", () => {
  const scope: IdpScope = { kind: "system" };

  it("should remove from Cognito then DDB", async () => {
    const deps = makeDeps();
    await createIdp(deps, scope, happyBody);
    const res = await deleteIdp(deps, scope, "okta-acme");
    expect(res).toBe(true);
    expect(deps.cognito.deleted).toEqual(["okta-acme"]);
    expect(await deps.store.get(scope, "okta-acme")).toBeNull();
  });

  it("should return not_found when idpId is unknown", async () => {
    const deps = makeDeps();
    const res = await deleteIdp(deps, scope, "missing");
    expect(typeof res === "object" && "error" in res && res.error.kind).toBe("not_found");
  });
});

describe("getIdp", () => {
  it("should return not_found when missing", async () => {
    const deps = makeDeps();
    const res = await getIdp(deps, { kind: "system" }, "missing");
    expect("error" in res && res.error.kind).toBe("not_found");
  });
});

describe("listIdps (tenant isolation)", () => {
  it("should never bleed system IdPs into a tenant scope", async () => {
    const deps = makeDeps();
    await createIdp(deps, { kind: "system" }, happyBody);
    await createIdp(
      deps,
      { kind: "tenant", tenantId: "acme" },
      {
        ...happyBody,
        idpId: "okta-acme-tenant",
      },
    );
    const sysList = await listIdps(deps, { kind: "system" });
    const tenList = await listIdps(deps, { kind: "tenant", tenantId: "acme" });
    expect(sysList.map((i) => i.idpId)).toEqual(["okta-acme"]);
    expect(tenList.map((i) => i.idpId)).toEqual(["okta-acme-tenant"]);
  });
});

describe("emitAudit", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("should structured-log the audit event so #1292 subscriber can consume it", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const deps = makeDeps();
    await createIdp(deps, { kind: "system" }, happyBody);
    // createIdp itself doesn't emit; routes layer emits — but we exercise the
    // direct helper to lock the wire shape.
    const { emitAudit } = await import("../../lib/control-plane/handlers/idp-handler/core");
    emitAudit({
      action: "idp.create",
      scope: { kind: "tenant", tenantId: "acme" },
      actorSub: "user-1",
      idpId: "okta-acme",
      outcome: "success",
    });
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls[0][0] as Record<string, unknown>;
    expect(call.event).toBe("audit.idp");
    expect(call.scopeKind).toBe("tenant");
    expect(call.tenantId).toBe("acme");
  });
});
