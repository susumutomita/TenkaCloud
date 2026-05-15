import { type VerifyOptions, type VerifyOutcome, verifySignature } from "./jws.js";
import type { CloudActionIntent, VerifiedCloudActionIntent } from "./schema.js";
import { brandVerified, parseCloudActionIntent } from "./schema.js";

/**
 * Issue #795 / ADR-017 Phase 1: 上位 verify entrypoint。
 *
 * JWS 検証 → schema 検証 → TTL 検証 → nonce hook 評価 を順に実施し、
 * 失敗した最初の reason を 1 つ返す。 audit record は本 entry の戻り値から
 * `auditRecord.ts` が組み立てる (= 失敗系も audit に残す方針)。
 *
 * TTL 検証は constraints.expiresAt と constraints.notBefore を `now` と
 * 比較する (= 単純 string ISO 比較は時刻順に動かないので Date.parse 経由)。
 *
 * nonce hook は caller が DDB / Redis 等のバックエンドを差し込める。 Phase 1
 * では「同じ nonce を 2 度 verify できない」 ことを caller 責任で担保する
 * 抽象だけ提供する (= no built-in storage)。
 */

export interface NonceStore {
  /**
   * 同じ nonce を 2 度受理しないために caller が実装する hook。
   * - 戻り値が `"accepted"` なら verify 続行
   * - 戻り値が `"replay"` なら verify 失敗 (= replay attack)
   *
   * Phase 1 の expectation: store は intent 全体ではなく `(requestId, nonce, expiresAt)`
   * を idempotency key として記録する。 TTL すぎたら GC する (= DDB TTL 等)。
   */
  recordNonce(intent: CloudActionIntent): Promise<"accepted" | "replay">;
}

export type IntentVerifyFailureReason =
  | "jws-malformed"
  | "jws-unknown-algorithm"
  | "jws-secret-not-resolved"
  | "jws-signature-mismatch"
  | "jws-payload-parse-failed"
  | "schema-invalid"
  | "not-yet-valid"
  | "expired"
  | "nonce-replay";

export interface IntentVerifyOk {
  readonly ok: true;
  readonly intent: VerifiedCloudActionIntent;
}

export interface IntentVerifyError {
  readonly ok: false;
  readonly reason: IntentVerifyFailureReason;
  readonly details?: readonly string[];
}

export type IntentVerifyOutcome = IntentVerifyOk | IntentVerifyError;

export interface IntentVerifyOptions extends VerifyOptions {
  readonly nonceStore?: NonceStore;
  readonly now?: () => Date;
}

function mapJwsReason(reason: VerifyOutcome & { ok: false }): IntentVerifyFailureReason {
  switch (reason.reason) {
    case "malformed-token":
      return "jws-malformed";
    case "unknown-algorithm":
      return "jws-unknown-algorithm";
    case "secret-not-resolved":
      return "jws-secret-not-resolved";
    case "signature-mismatch":
      return "jws-signature-mismatch";
    case "payload-parse-failed":
      return "jws-payload-parse-failed";
    case "payload-schema-invalid":
      return "schema-invalid";
  }
}

export async function verifyIntent(
  token: string,
  options: IntentVerifyOptions,
): Promise<IntentVerifyOutcome> {
  const jwsOutcome = verifySignature(token, options);
  if (!jwsOutcome.ok) {
    return { ok: false, reason: mapJwsReason(jwsOutcome) };
  }

  const schemaOutcome = parseCloudActionIntent(jwsOutcome.intent);
  if (!schemaOutcome.ok) {
    return { ok: false, reason: "schema-invalid", details: schemaOutcome.issues };
  }

  const intent = schemaOutcome.intent;
  const now = (options.now ?? (() => new Date()))();
  const expiresAt = new Date(intent.constraints.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    // datetime() で schema が弾く想定だが防御的に。
    return { ok: false, reason: "schema-invalid", details: ["constraints.expiresAt"] };
  }
  if (expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  if (intent.constraints.notBefore) {
    const nbf = new Date(intent.constraints.notBefore);
    if (Number.isNaN(nbf.getTime())) {
      return { ok: false, reason: "schema-invalid", details: ["constraints.notBefore"] };
    }
    if (now.getTime() < nbf.getTime()) {
      return { ok: false, reason: "not-yet-valid" };
    }
  }

  if (options.nonceStore) {
    const outcome = await options.nonceStore.recordNonce(intent);
    if (outcome === "replay") {
      return { ok: false, reason: "nonce-replay" };
    }
  }

  return { ok: true, intent: brandVerified(intent) };
}
