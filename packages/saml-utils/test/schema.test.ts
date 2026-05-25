import { describe, expect, it } from "vitest";
import { CreateIdpInputSchema, IdpIdSchema, UpdateIdpInputSchema } from "../src/schema.js";

describe("IdpIdSchema", () => {
  it("should accept Cognito-compatible IdP IDs", () => {
    expect(IdpIdSchema.safeParse("okta-acme").success).toBe(true);
    expect(IdpIdSchema.safeParse("Azure_Tenant1").success).toBe(true);
  });

  it("should reject IdP IDs with spaces / punctuation that Cognito rejects", () => {
    expect(IdpIdSchema.safeParse("ok ta").success).toBe(false);
    expect(IdpIdSchema.safeParse("ok.ta").success).toBe(false);
    expect(IdpIdSchema.safeParse("ab").success).toBe(false); // too short
  });
});

describe("CreateIdpInputSchema", () => {
  const happy = {
    idpId: "okta-acme",
    displayName: "Acme Okta",
    description: "Production Okta tenant",
    metadataXml: '<EntityDescriptor entityID="x"/>',
    attributeMapping: {
      email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
      displayName: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
      groups: "http://schemas.xmlsoap.org/claims/Group",
    },
    groupToRole: {
      "ops-admins": "TenantAdmin",
      observers: "Viewer",
    },
  };

  it("should accept a happy-path body", () => {
    expect(CreateIdpInputSchema.safeParse(happy).success).toBe(true);
  });

  it("should reject a missing required field", () => {
    const { idpId: _drop, ...rest } = happy;
    expect(CreateIdpInputSchema.safeParse(rest).success).toBe(false);
  });

  it("should reject an unknown role in groupToRole", () => {
    expect(
      CreateIdpInputSchema.safeParse({
        ...happy,
        groupToRole: { admins: "Wizard" },
      }).success,
    ).toBe(false);
  });
});

describe("UpdateIdpInputSchema", () => {
  it("should accept a partial update", () => {
    expect(UpdateIdpInputSchema.safeParse({ displayName: "Renamed" }).success).toBe(true);
  });

  it("should reject extra fields", () => {
    expect(
      UpdateIdpInputSchema.safeParse({ displayName: "x", idpId: "must-not-be-here" }).success,
    ).toBe(false);
  });
});
