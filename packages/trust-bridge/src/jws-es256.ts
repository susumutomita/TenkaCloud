import type { webcrypto } from "node:crypto";
import { base64urlDecode, base64urlEncode, type JwsHeader, type VerifyOutcome } from "./jws.js";
import { type CloudActionIntent, canonicalize } from "./schema.js";

type JsonWebKey = webcrypto.JsonWebKey;

/** JWS algorithm identifier for ECDSA using P-256 and SHA-256. */
export const ALG_ES256 = "ES256" as const;

export interface Es256SignOptions {
  readonly privateKey: JsonWebKey;
  readonly kid?: string;
}

export interface Es256VerifyOptions {
  readonly resolvePublicKey: (
    header: JwsHeader,
  ) => JsonWebKey | undefined | Promise<JsonWebKey | undefined>;
}

/**
 * Sign a canonical CloudActionIntent as compact ES256 JWS.
 *
 * WebCrypto emits the P-256 signature in JWS-compatible raw r||s form (64 bytes);
 * no DER conversion is performed.
 */
export async function signIntentEs256(
  intent: CloudActionIntent,
  options: Es256SignOptions,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    options.privateKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header: JwsHeader = {
    alg: ALG_ES256,
    typ: "JWS",
    ...(options.kid === undefined ? {} : { kid: options.kid }),
  };
  const headerB64 = base64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64urlEncode(new TextEncoder().encode(canonicalize(intent)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${base64urlEncode(signature)}`;
}

/** Verify only the compact JWS signature and decode its intent payload. */
export async function verifySignatureEs256(
  token: string,
  options: Es256VerifyOptions,
): Promise<VerifyOutcome> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "malformed-token" };
  }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: JwsHeader;
  try {
    const headerJson = new TextDecoder().decode(base64urlDecode(headerB64));
    const parsed = JSON.parse(headerJson) as JwsHeader;
    if (parsed.typ !== "JWS") {
      return { ok: false, reason: "malformed-token" };
    }
    header = parsed;
  } catch {
    return { ok: false, reason: "malformed-token" };
  }

  if (header.alg !== ALG_ES256) {
    return { ok: false, reason: "unknown-algorithm" };
  }

  const jwk = await options.resolvePublicKey(header);
  if (!jwk) {
    return { ok: false, reason: "secret-not-resolved" };
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    base64urlDecode(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!valid) {
    return { ok: false, reason: "signature-mismatch" };
  }

  let intent: CloudActionIntent;
  try {
    const payloadJson = new TextDecoder().decode(base64urlDecode(payloadB64));
    intent = JSON.parse(payloadJson) as CloudActionIntent;
  } catch {
    return { ok: false, reason: "payload-parse-failed" };
  }

  return { ok: true, intent, header };
}
