import type { SamlIdpConfig } from "@tenkacloud/saml-utils";
import { describe, expect, it, vi } from "vitest";
import {
  createIdp,
  deleteIdp,
  emitAudit,
  type IdpHandlerDeps,
  type IdpScope,
  updateIdp,
} from "../../lib/control-plane/handlers/idp-handler/core";

/**
 * Issue #1418: idp-handler/core.ts は 60% branch だった。 既存 core.test は happy / validation /
 * limit / not_found を見るが、 updateIdp の success / metadata-invalid / Cognito-throw、 deleteIdp の
 * Cognito-throw、 非 Error の "cognito error" message、 emitAudit の tenant/system 枝が未カバー。
 */
const VALID_METADATA = `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="http://idp.test/entity">
  <md:IDPSSODescriptor>
    <md:KeyDescriptor><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>BASE64</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
const existing: SamlIdpConfig = {
  idpId: "okta-acme",
  displayName: "Acme",
  metadataXml: VALID_METADATA,
  attributeMapping: { email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress" },
  groupToRole: { admins: "TenantAdmin" },
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
};
const SCOPE: IdpScope = { kind: "system" };
const happyCreate = {
  idpId: "new-idp",
  displayName: "New",
  metadataXml: VALID_METADATA,
  attributeMapping: { email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress" },
  groupToRole: { admins: "TenantAdmin" },
};

const deps = (over: {
  current?: SamlIdpConfig | null;
  cognito?: Partial<IdpHandlerDeps["cognito"]>;
}): IdpHandlerDeps =>
  ({
    store: {
      get: vi.fn().mockResolvedValue(over.current ?? null),
      list: vi.fn().mockResolvedValue([]),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    cognito: {
      createIdp: vi.fn().mockResolvedValue(undefined),
      updateIdp: vi.fn().mockResolvedValue(undefined),
      deleteIdp: vi.fn().mockResolvedValue(undefined),
      ...over.cognito,
    },
    now: () => new Date("2026-05-24T00:00:00.000Z"),
  }) as unknown as IdpHandlerDeps;

describe("createIdp Cognito non-Error rejection", () => {
  it("should surface 'cognito error' when createIdp throws a non-Error", async () => {
    const res = await createIdp(
      deps({ cognito: { createIdp: vi.fn().mockRejectedValue("x") } }),
      SCOPE,
      happyCreate,
    );
    expect("error" in res && res.error).toMatchObject({
      kind: "internal",
      message: "cognito error",
    });
  });

  it("should carry description + tenantId for a tenant-scope create", async () => {
    const tenantScope: IdpScope = { kind: "tenant", tenantId: "t9" };
    const res = await createIdp(deps({}), tenantScope, { ...happyCreate, description: "desc" });
    expect("error" in res).toBe(false);
    expect(res as SamlIdpConfig).toMatchObject({ description: "desc", tenantId: "t9" });
  });
});

describe("updateIdp", () => {
  it("should merge and persist on the happy path", async () => {
    const res = await updateIdp(deps({ current: existing }), SCOPE, "okta-acme", {
      displayName: "Renamed",
    });
    expect("error" in res).toBe(false);
    expect((res as SamlIdpConfig).displayName).toBe("Renamed");
    expect((res as SamlIdpConfig).updatedAt).toBe("2026-05-24T00:00:00.000Z");
  });
  it("should merge every patch field (incl. valid new metadata)", async () => {
    const res = await updateIdp(deps({ current: existing }), SCOPE, "okta-acme", {
      displayName: "All",
      description: "d",
      metadataXml: VALID_METADATA,
      attributeMapping: {
        email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
      },
      groupToRole: { admins: "TenantAdmin" },
    });
    expect("error" in res).toBe(false);
    expect(res as SamlIdpConfig).toMatchObject({ displayName: "All", description: "d" });
  });
  it("should reject an update body that fails schema validation", async () => {
    const res = await updateIdp(deps({ current: existing }), SCOPE, "okta-acme", {
      displayName: 123, // wrong type
    });
    expect("error" in res && res.error.kind).toBe("validation");
  });
  it("should merge a patch that omits displayName (description-only update)", async () => {
    const res = await updateIdp(deps({ current: existing }), SCOPE, "okta-acme", {
      description: "only-desc",
    });
    expect("error" in res).toBe(false);
    expect((res as SamlIdpConfig).displayName).toBe("Acme"); // unchanged from current
    expect((res as SamlIdpConfig).description).toBe("only-desc");
  });
  it("should reject invalid metadata supplied in an update", async () => {
    const badMeta = VALID_METADATA.replace(/IDPSSODescriptor/g, "SPSSODescriptor");
    const res = await updateIdp(deps({ current: existing }), SCOPE, "okta-acme", {
      metadataXml: badMeta,
    });
    expect("error" in res && res.error.kind).toBe("invalid_metadata");
  });
  it("should surface a Cognito Error as internal", async () => {
    const res = await updateIdp(
      deps({
        current: existing,
        cognito: { updateIdp: vi.fn().mockRejectedValue(new Error("boom")) },
      }),
      SCOPE,
      "okta-acme",
      { displayName: "X" },
    );
    expect("error" in res && res.error).toMatchObject({ kind: "internal", message: "boom" });
  });
  it("should surface a non-Error Cognito rejection as 'cognito error'", async () => {
    const res = await updateIdp(
      deps({ current: existing, cognito: { updateIdp: vi.fn().mockRejectedValue("x") } }),
      SCOPE,
      "okta-acme",
      { displayName: "X" },
    );
    expect("error" in res && res.error).toMatchObject({ message: "cognito error" });
  });
});

describe("deleteIdp", () => {
  it("should surface a Cognito Error as internal", async () => {
    const res = await deleteIdp(
      deps({
        current: existing,
        cognito: { deleteIdp: vi.fn().mockRejectedValue(new Error("boom")) },
      }),
      SCOPE,
      "okta-acme",
    );
    expect("error" in res && res.error).toMatchObject({ kind: "internal", message: "boom" });
  });
  it("should surface a non-Error Cognito rejection as 'cognito error'", async () => {
    const res = await deleteIdp(
      deps({ current: existing, cognito: { deleteIdp: vi.fn().mockRejectedValue("x") } }),
      SCOPE,
      "okta-acme",
    );
    expect("error" in res && res.error).toMatchObject({ message: "cognito error" });
  });
});

describe("emitAudit", () => {
  it("should emit a system-scope audit line", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    emitAudit({
      action: "idp.create",
      scope: { kind: "system" },
      actorSub: "s",
      outcome: "success",
    });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKind: "system", tenantId: undefined }),
    );
    info.mockRestore();
  });
  it("should emit a tenant-scope audit line with the tenantId", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    emitAudit({
      action: "idp.delete",
      scope: { kind: "tenant", tenantId: "t9" },
      actorSub: "s",
      idpId: "i1",
      outcome: "error",
      errorMessage: "boom",
    });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKind: "tenant", tenantId: "t9" }),
    );
    info.mockRestore();
  });
});
