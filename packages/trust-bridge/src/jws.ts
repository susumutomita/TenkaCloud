import { createHmac, timingSafeEqual } from "node:crypto";
import { type CloudActionIntent, canonicalize } from "./schema.js";

/**
 * Issue #795: minimal JWS compact serialization for
 * CloudActionIntent。
 *
 * Phase 1 では HS256 (HMAC-SHA256) のみ実装する。 これは:
 *  - 鍵管理を持ち込まず unit test 可能にする最小形 (= 共有 secret 1 個)
 *  - JWS spec (RFC 7515) compact 形式の payload encoding / signature 検証
 *    ロジックを pin する
 *  - Phase 2 で AWS adapter を入れるときに ES256 / RS256 を追加できる
 *    interface 形 (= sign/verify が alg を switch する余地)
 *
 * production 移行時の方針:
 *  - KMS / Cloud HSM 経由の非対称鍵 (ES256 / RS256) に差し替える
 *  - 共有 secret HS256 は internal tooling と test 限定で残す
 *  - 本 module は node:crypto のみに依存し、追加の暗号ライブラリを持ち込まない
 *  - HMAC は OpenSSL bindings を使う createHmac に委ね、独自実装するのは
 *    RFC 7515 に従う単純な base64url framing のみ
 */

const ALG_HS256 = "HS256" as const;
type Alg = typeof ALG_HS256 | "ES256";

export interface JwsHeader {
  readonly alg: Alg;
  readonly typ: "JWS";
  readonly kid?: string;
}

export interface SignOptions {
  readonly secret: Uint8Array;
  readonly kid?: string;
}

export interface VerifyOptions {
  readonly resolveSecret?: (header: JwsHeader) => Uint8Array | undefined;
}

export type VerifyOutcome =
  | { readonly ok: true; readonly intent: CloudActionIntent; readonly header: JwsHeader }
  | { readonly ok: false; readonly reason: VerifyFailureReason };

export type VerifyFailureReason =
  | "malformed-token"
  | "unknown-algorithm"
  | "secret-not-resolved"
  | "signature-mismatch"
  | "payload-parse-failed";

export function base64urlEncode(bytes: Uint8Array): string {
  return (
    Buffer.from(bytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      // Strip base64 padding with a global char replace, NOT an anchored `/=+$/`: now that this
      // helper is exported (jws-es256 reuses it), CodeQL flags `=+$` as js/polynomial-redos on
      // library input. `=` only ever appears as trailing padding in base64 output, so removing
      // every `=` is equivalent and has no backtracking.
      .replace(/=/g, "")
  );
}

export function base64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const decoded = Buffer.from(padded + pad, "base64");
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes;
}

function hmacSha256(secret: Uint8Array, signingInput: string): Uint8Array {
  const mac = createHmac("sha256", secret);
  mac.update(signingInput);
  return new Uint8Array(mac.digest());
}

/**
 * Issue #795: CloudActionIntent → JWS compact serialization。
 *
 * payload は canonicalize() の出力 (= sorted-key JSON) を使う。 検証側で
 * 同じ payload を再現するためには parse → re-canonicalize が必要だが、
 * Phase 1 では「sender が作った確定 bytes をそのまま JWS payload に
 * 載せる」 ことを優先する (= MAC は bytes に対して計算される)。
 */
export function signIntent(intent: CloudActionIntent, options: SignOptions): string {
  const header: JwsHeader = {
    alg: ALG_HS256,
    typ: "JWS",
    ...(options.kid === undefined ? {} : { kid: options.kid }),
  };
  const headerB64 = base64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadCanonical = canonicalize(intent);
  const payloadB64 = base64urlEncode(new TextEncoder().encode(payloadCanonical));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = hmacSha256(options.secret, signingInput);
  const signatureB64 = base64urlEncode(signature);
  return `${signingInput}.${signatureB64}`;
}

/**
 * Issue #795: verify JWS compact token → CloudActionIntent。
 *
 * TTL 検証 / nonce 検証 / policy 評価 は本 module の責務ではない (= layer 分離)。
 * 上位の `verifyIntent` (`./verify.ts`) が TTL / nonce / audit を組み合わせる。
 */
export function verifySignature(token: string, options: VerifyOptions): VerifyOutcome {
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

  if (header.alg !== ALG_HS256) {
    return { ok: false, reason: "unknown-algorithm" };
  }

  const secret = options.resolveSecret?.(header);
  if (!secret) {
    return { ok: false, reason: "secret-not-resolved" };
  }

  const expected = hmacSha256(secret, `${headerB64}.${payloadB64}`);
  const provided = base64urlDecode(signatureB64);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
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
