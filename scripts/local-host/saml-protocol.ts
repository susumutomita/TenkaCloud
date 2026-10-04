import { X509Certificate } from "node:crypto";
import { type CacheProvider, type Profile, SAML, ValidateInResponseTo } from "@node-saml/node-saml";
import { DOMParser, type Element } from "@xmldom/xmldom";
import { z } from "zod";
import { HostError } from "./model";

const PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";
const ASSERTION = "urn:oasis:names:tc:SAML:2.0:assertion";
const SIGNATURE = "http://www.w3.org/2000/09/xmldsig#";
const PERSISTENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
export const SAML_REQUEST_TTL = 5 * 60_000;
const CLOCK_SKEW = 30_000;

export const SamlProviderSchema = z
  .object({
    issuer: z.string().min(1).max(1024),
    entryPoint: z.string().url().max(2048),
    certificate: z.string().min(1).max(32768),
  })
  .strict();
export type SamlProvider = z.infer<typeof SamlProviderSchema>;

export function parseSamlProvider(raw: unknown): SamlProvider {
  const parsed = SamlProviderSchema.safeParse(raw);
  if (!parsed.success)
    throw new HostError(400, "Provide the IdP issuer, sign-in URL and signing certificate.");
  const provider = parsed.data;
  const endpoint = new URL(provider.entryPoint);
  const loopback =
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "127.0.0.1" ||
    endpoint.hostname === "[::1]";
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback))
  )
    throw new HostError(
      400,
      "The IdP sign-in URL must use HTTPS (HTTP is allowed only on loopback).",
    );
  try {
    const certificate = new X509Certificate(provider.certificate);
    if (
      certificate.publicKey.asymmetricKeyType !== "rsa" ||
      (certificate.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      throw new Error("Unsupported signing key.");
  } catch {
    throw new HostError(
      400,
      "Provide an X.509 certificate with an RSA signing key of at least 2048 bits.",
    );
  }
  return provider;
}

function invalid(): never {
  throw new HostError(
    401,
    "SAML sign-in could not be verified. Start sign-in again.",
    "invalid_saml_response",
  );
}

function parseXml(xml: string): Element {
  if (Buffer.byteLength(xml) > 192 * 1024 || /<!DOCTYPE|<!ENTITY/iu.test(xml)) invalid();
  let malformed = false;
  const document = new DOMParser({
    onError: () => {
      malformed = true;
    },
  }).parseFromString(xml, "application/xml");
  if (malformed || !document.documentElement) invalid();
  return document.documentElement;
}

function children(element: Element, namespace: string, name: string): Element[] {
  return Array.from(element.childNodes).filter(
    (node): node is Element =>
      node.nodeType === 1 &&
      "namespaceURI" in node &&
      node.namespaceURI === namespace &&
      "localName" in node &&
      node.localName === name,
  );
}

function child(element: Element, namespace: string, name: string): Element {
  const matches = children(element, namespace, name);
  const found = matches[0];
  if (matches.length !== 1 || !found) invalid();
  return found;
}

function attr(element: Element, name: string): string {
  const value = element.getAttribute(name);
  if (!value) invalid();
  return value;
}

function instant(value: string): number {
  if (!z.string().datetime({ offset: true }).safeParse(value).success) invalid();
  return Date.parse(value);
}

function textContent(element: Element): string {
  const value = element.textContent;
  if (
    !value ||
    value.trim() !== value ||
    value.length > 1024 ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  )
    invalid();
  return value;
}

function modernSignatures(root: Element): void {
  const signatures = Array.from(root.getElementsByTagNameNS(SIGNATURE, "SignatureMethod"));
  const digests = Array.from(root.getElementsByTagNameNS(SIGNATURE, "DigestMethod"));
  if (signatures.length !== 2 || digests.length !== 2) invalid();
  for (const signature of signatures) {
    if (
      ![
        "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
        "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
      ].includes(attr(signature, "Algorithm"))
    )
      invalid();
  }
  for (const digest of digests) {
    if (
      ![
        "http://www.w3.org/2001/04/xmlenc#sha256",
        "http://www.w3.org/2001/04/xmlenc#sha512",
      ].includes(attr(digest, "Algorithm"))
    )
      invalid();
  }
}

function responseEnvelope(
  encoded: string,
  callbackUrl: string,
  issuer: string,
  expectedRequestId: string,
): string {
  const base64 = encoded.replace(/\s/gu, "");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) invalid();
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const response = parseXml(xml);
  if (
    response.namespaceURI !== PROTOCOL ||
    response.localName !== "Response" ||
    attr(response, "Version") !== "2.0" ||
    attr(response, "Destination") !== callbackUrl ||
    attr(response, "InResponseTo") !== expectedRequestId ||
    textContent(child(response, ASSERTION, "Issuer")) !== issuer
  )
    invalid();
  const status = child(child(response, PROTOCOL, "Status"), PROTOCOL, "StatusCode");
  if (attr(status, "Value") !== "urn:oasis:names:tc:SAML:2.0:status:Success") invalid();
  modernSignatures(response);
  return base64;
}

export interface SamlIdentityProof {
  readonly issuer: string;
  readonly subject: string;
  readonly assertionId: string;
  readonly requestId: string;
  readonly expiresAt: number;
}

function assertionProof(
  profile: Profile,
  callbackUrl: string,
  expectedRequestId: string,
  now: number,
): SamlIdentityProof {
  const assertion = parseXml(profile.getAssertionXml?.() ?? invalid());
  if (
    assertion.namespaceURI !== ASSERTION ||
    assertion.localName !== "Assertion" ||
    attr(assertion, "Version") !== "2.0"
  )
    invalid();
  const issuedAt = instant(attr(assertion, "IssueInstant"));
  if (issuedAt > now + CLOCK_SKEW || issuedAt < now - SAML_REQUEST_TTL - CLOCK_SKEW) invalid();
  const subject = child(assertion, ASSERTION, "Subject");
  const nameId = child(subject, ASSERTION, "NameID");
  if (attr(nameId, "Format") !== PERSISTENT || textContent(nameId) !== profile.nameID) invalid();
  const confirmation = child(subject, ASSERTION, "SubjectConfirmation");
  if (attr(confirmation, "Method") !== BEARER) invalid();
  const data = child(confirmation, ASSERTION, "SubjectConfirmationData");
  if (attr(data, "Recipient") !== callbackUrl || attr(data, "InResponseTo") !== expectedRequestId)
    invalid();
  const conditions = child(assertion, ASSERTION, "Conditions");
  const notBefore = instant(attr(conditions, "NotBefore"));
  const expiresAt = Math.min(
    instant(attr(conditions, "NotOnOrAfter")),
    instant(attr(data, "NotOnOrAfter")),
    issuedAt + SAML_REQUEST_TTL,
  );
  if (notBefore > now + CLOCK_SKEW || expiresAt <= now) invalid();
  return {
    issuer: profile.issuer,
    subject: textContent(nameId),
    assertionId: attr(assertion, "ID"),
    requestId: expectedRequestId,
    expiresAt,
  };
}

export class SamlProtocol {
  private readonly saml: SAML;
  readonly callbackUrl: string;
  readonly entityId: string;

  constructor(
    private readonly options: {
      readonly provider: SamlProvider;
      readonly origin: string;
      readonly cache: CacheProvider;
      readonly requestId?: string;
    },
  ) {
    this.callbackUrl = `${options.origin}/api/host/saml/acs`;
    this.entityId = `${options.origin}/api/host/saml/metadata`;
    this.saml = new SAML({
      callbackUrl: this.callbackUrl,
      issuer: this.entityId,
      audience: this.entityId,
      entryPoint: options.provider.entryPoint,
      idpCert: options.provider.certificate,
      idpIssuer: options.provider.issuer,
      identifierFormat: PERSISTENT,
      allowCreate: false,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: true,
      signatureAlgorithm: "sha256",
      digestAlgorithm: "sha256",
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: SAML_REQUEST_TTL,
      maxAssertionAgeMs: SAML_REQUEST_TTL,
      acceptedClockSkewMs: CLOCK_SKEW,
      cacheProvider: options.cache,
      ...(options.requestId ? { generateUniqueId: () => options.requestId ?? invalid() } : {}),
    });
  }

  metadata(): string {
    return this.saml.generateServiceProviderMetadata(null);
  }

  authorize(relayState: string): Promise<string> {
    return this.saml.getAuthorizeUrlAsync(relayState, undefined, {});
  }

  async verify(
    encoded: string,
    expectedRequestId: string,
    now = Date.now(),
  ): Promise<SamlIdentityProof> {
    try {
      const base64 = responseEnvelope(
        encoded,
        this.callbackUrl,
        this.options.provider.issuer,
        expectedRequestId,
      );
      const { profile, loggedOut } = await this.saml.validatePostResponseAsync({
        SAMLResponse: base64,
      });
      if (
        loggedOut ||
        !profile ||
        profile.issuer !== this.options.provider.issuer ||
        profile.inResponseTo !== expectedRequestId ||
        profile.nameIDFormat !== PERSISTENT ||
        (profile.nameQualifier !== undefined && profile.nameQualifier !== profile.issuer) ||
        (profile.spNameQualifier !== undefined && profile.spNameQualifier !== this.entityId)
      )
        invalid();
      return assertionProof(profile, this.callbackUrl, expectedRequestId, now);
    } catch {
      invalid();
    }
  }
}
