import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Issue #1973: 署名付きクリアコード。
 *
 * 固定文字列を返さず、 `runId` / `challengeId` / `stage` / 発行・失効時刻 / `nonce` を含む
 * HMAC-SHA256 署名トークンにする。 これにより「ローカルで API を実行しただけ」「リポジトリを
 * 読んだだけ」では正しいコードを生成できない (= 署名鍵は TenkaCloud 側のみが持つ)。
 *
 * このモジュールは **純粋な署名/検証だけ** を担う:
 *   - nonce / 時刻の生成は呼び出し側 (app 層) が注入する → 決定的にテストできる
 *   - 「一回限り (= 同 nonce の再使用拒否)」「同 stage 再発行の冪等化」は RunRepository の責務
 */
export interface ClearCodeClaims {
  readonly runId: string;
  readonly challengeId: string;
  readonly stage: string;
  /** 発行時刻 (epoch ms)。 */
  readonly issuedAt: number;
  /** 失効時刻 (epoch ms)。 */
  readonly expiresAt: number;
  /** run/stage ごとに一意な使い捨て値。 */
  readonly nonce: string;
}

export type ClearCodeVerifyResult =
  | { readonly ok: true; readonly claims: ClearCodeClaims }
  | { readonly ok: false; readonly reason: string };

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

/** claims を base64url(payload).base64url(hmac) 形式の署名トークンに変換する。 */
export function issueClearCode(claims: ClearCodeClaims, secret: string): string {
  const payloadB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

/** トークンの署名と有効期限を検証する。 `nowMs` は呼び出し側が注入する。 */
export function verifyClearCode(
  token: string,
  secret: string,
  nowMs: number,
): ClearCodeVerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    return { ok: false, reason: "トークンの形式が不正です" };
  }
  const [payloadB64, providedSig] = parts;
  const expectedSig = sign(payloadB64, secret);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "署名が一致しません" };
  }
  let claims: ClearCodeClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as ClearCodeClaims;
  } catch {
    return { ok: false, reason: "payload を復号できません" };
  }
  if (nowMs > claims.expiresAt) {
    return { ok: false, reason: "有効期限切れです" };
  }
  return { ok: true, claims };
}
