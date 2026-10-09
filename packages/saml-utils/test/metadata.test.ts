import { describe, expect, it } from "vitest";
import {
  SAML_METADATA_MAX_BYTES,
  toCognitoProviderDetails,
  validateSamlMetadata,
} from "../src/metadata.js";

const OKTA_LIKE = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="http://www.okta.com/exk1tenant">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
        <ds:X509Data>
          <ds:X509Certificate>MIIDpDCCAoygAwIBAgI...truncated...</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://example.okta.com/app/sso/saml"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

describe("toCognitoProviderDetails", () => {
  it("should pin MetadataFile to the provided XML and return a frozen object", () => {
    const details = toCognitoProviderDetails({ metadataXml: OKTA_LIKE });
    expect(details.MetadataFile).toBe(OKTA_LIKE);
    expect(Object.isFrozen(details)).toBe(true);
  });
});

describe("validateSamlMetadata", () => {
  it("should accept a well-formed Okta-like metadata XML and extract the entityID", () => {
    const result = validateSamlMetadata(OKTA_LIKE);
    expect(result.ok).toBe(true);
    expect(result.entityId).toBe("http://www.okta.com/exk1tenant");
  });

  it("should reject empty input", () => {
    expect(validateSamlMetadata("")).toEqual({ ok: false, reason: "empty" });
    expect(validateSamlMetadata("   ")).toEqual({ ok: false, reason: "empty" });
    expect(validateSamlMetadata(undefined)).toEqual({ ok: false, reason: "empty" });
  });

  it("should reject input that exceeds the size cap", () => {
    const padding = "a".repeat(SAML_METADATA_MAX_BYTES + 1);
    expect(validateSamlMetadata(padding).reason).toBe("too_large");
  });

  it("should reject input that is not XML", () => {
    expect(validateSamlMetadata("not xml at all")).toEqual({
      ok: false,
      reason: "not_xml",
    });
  });

  it("should reject when EntityDescriptor is missing", () => {
    const xml = "<root><foo/></root>";
    expect(validateSamlMetadata(xml).reason).toBe("missing_entity_descriptor");
  });

  it("should reject when entityID attribute is missing", () => {
    const xml = OKTA_LIKE.replace(/\sentityID="[^"]+"/, "");
    expect(validateSamlMetadata(xml).reason).toBe("missing_entity_id");
  });

  it("should reject when IDPSSODescriptor is missing (e.g. an SP descriptor was uploaded)", () => {
    const xml = OKTA_LIKE.replace(/IDPSSODescriptor/g, "SPSSODescriptor");
    expect(validateSamlMetadata(xml).reason).toBe("missing_idp_sso_descriptor");
  });

  it("should reject when both signing cert and Signature element are absent", () => {
    const xml = OKTA_LIKE.replace(/<ds:X509Certificate[\s\S]*?<\/ds:X509Certificate>/, "");
    expect(validateSamlMetadata(xml).reason).toBe("missing_signing_material");
  });

  it("should reject when NameIDFormat is missing", () => {
    const xml = OKTA_LIKE.replace(/<md:NameIDFormat[\s\S]*?<\/md:NameIDFormat>/, "");
    expect(validateSamlMetadata(xml).reason).toBe("missing_name_id_format");
  });
});

describe("SAML metadata のDTD/entity境界", () => {
  it.each([
    '<!DOCTYPE md:EntityDescriptor SYSTEM "https://example.com/metadata.dtd">',
    '<!DOCTYPE md:EntityDescriptor [<!ENTITY example "value">]>',
    '<!DOCTYPE md:EntityDescriptor [<!ENTITY % example SYSTEM "https://example.com/entity.dtd">%example;]>',
    '<!ENTITY example SYSTEM "file:///example">',
    "<!doctype md:EntityDescriptor>",
  ])("宣言 %s をCognitoへ渡す前に拒否するべき", (declaration) => {
    const xml = OKTA_LIKE.replace(/<\?xml[^?]*\?>/, `$&\n${declaration}`);
    expect(validateSamlMetadata(xml)).toEqual({ ok: false, reason: "not_xml" });
  });
  it("DTDなしのXML宣言と組込みentityは維持するべき", () => {
    expect(
      validateSamlMetadata(
        OKTA_LIKE.replace(
          'WantAuthnRequestsSigned="false"',
          'WantAuthnRequestsSigned="false" note="A &amp; B"',
        ),
      ).ok,
    ).toBe(true);
  });
});

describe("宣言とXMLの文字列内容を区別する", () => {
  it("コメントやCDATA内のDTD/entityの説明文字列は許可するべき", () => {
    const xml = OKTA_LIKE.replace(
      "<md:KeyDescriptor",
      '<!-- Example: <!DOCTYPE metadata> <!ENTITY example "text"> --><md:KeyDescriptor',
    ).replace(
      "</md:IDPSSODescriptor>",
      '<md:Extensions><![CDATA[<!DOCTYPE metadata> <!ENTITY example "text">]]></md:Extensions></md:IDPSSODescriptor>',
    );
    expect(validateSamlMetadata(xml).ok).toBe(true);
  });
  it("コメントの外や未終端コメント内の宣言は拒否するべき", () => {
    expect(validateSamlMetadata(`<!-- description --> <!DOCTYPE metadata>${OKTA_LIKE}`).ok).toBe(
      false,
    );
    expect(validateSamlMetadata(`<!-- unclosed <!DOCTYPE metadata>${OKTA_LIKE}`).ok).toBe(false);
  });
});
