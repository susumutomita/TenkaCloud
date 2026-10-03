import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { DOMParser } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";

const persistent = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
const sha256 = "http://www.w3.org/2001/04/xmlenc#sha256";
const canonical = "http://www.w3.org/2001/10/xml-exc-c14n#";
export class TestSamlIdP {
  readonly directory = mkdtempSync(join(tmpdir(), "host-saml-idp-"));
  readonly certificate: string;
  readonly privateKey: string;
  readonly issuer = "https://idp.example.test/saml";
  constructor() {
    try {
      const generated = Bun.spawnSync(
        [
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          join(this.directory, "idp.key"),
          "-out",
          join(this.directory, "idp.crt"),
          "-days",
          "1",
          "-subj",
          "/CN=idp.example.test",
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      if (generated.exitCode !== 0)
        throw new Error("Could not generate a test-only SAML certificate.");
      this.certificate = readFileSync(join(this.directory, "idp.crt"), "utf8");
      this.privateKey = readFileSync(join(this.directory, "idp.key"), "utf8");
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
  request(url: string) {
    const params = new URL(url).searchParams;
    const request = params.get("SAMLRequest");
    const relay = params.get("RelayState");
    if (!request || !relay) throw new Error("Missing SAML request or relay state.");
    const xml = inflateRawSync(Buffer.from(request, "base64")).toString();
    const document = new DOMParser().parseFromString(xml, "application/xml");
    const requestId = document.documentElement?.getAttribute("ID");
    const callback = document.documentElement?.getAttribute("AssertionConsumerServiceURL");
    if (!requestId || !callback) throw new Error("Missing SAML request ID or callback.");
    return { requestId, origin: new URL(callback).origin, callback, relay };
  }
  private signed(xml: string, element: "Assertion" | "Response", key = this.privateKey): string {
    const signer = new SignedXml({ privateKey: key, publicCert: this.certificate });
    signer.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
    signer.canonicalizationAlgorithm = canonical;
    signer.addReference({
      xpath: `//*[local-name()='${element}']`,
      transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", canonical],
      digestAlgorithm: sha256,
    });
    signer.computeSignature(xml, {
      prefix: "ds",
      location: {
        reference: `//*[local-name()='${element}']/*[local-name()='Issuer']`,
        action: "after",
      },
    });
    return signer.getSignedXml();
  }
  response(changes: {
    origin: string;
    requestId: string;
    issuer?: string;
    destination?: string;
    recipient?: string;
    audience?: string;
    subject?: string;
    format?: string;
    expires?: string;
    status?: string;
    assertionId?: string;
    key?: string;
  }): string {
    const origin = changes.origin;
    const entityId = `${origin}/api/host/saml/metadata`;
    const acs = `${origin}/api/host/saml/acs`;
    const now = Date.now();
    const issued = new Date(now - 1000).toISOString();
    const starts = new Date(now - 5000).toISOString();
    const expires = changes.expires ?? new Date(now + 60_000).toISOString();
    const source = changes.issuer ?? this.issuer;
    const correlation = changes.requestId;
    const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response" Version="2.0" IssueInstant="${issued}" Destination="${changes.destination ?? acs}" InResponseTo="${correlation}"><saml:Issuer>${source}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:${changes.status ?? "Success"}"/></samlp:Status><saml:Assertion ID="${changes.assertionId ?? "_assertion"}" Version="2.0" IssueInstant="${issued}"><saml:Issuer>${source}</saml:Issuer><saml:Subject><saml:NameID Format="${changes.format ?? persistent}" NameQualifier="${source}" SPNameQualifier="${entityId}">${changes.subject ?? "stable-subject-123"}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${correlation}" Recipient="${changes.recipient ?? acs}" NotOnOrAfter="${expires}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${starts}" NotOnOrAfter="${expires}"><saml:AudienceRestriction><saml:Audience>${changes.audience ?? entityId}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${issued}" SessionIndex="test-session"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement></saml:Assertion></samlp:Response>`;
    return Buffer.from(
      this.signed(this.signed(xml, "Assertion", changes.key), "Response", changes.key),
    ).toString("base64");
  }
}
