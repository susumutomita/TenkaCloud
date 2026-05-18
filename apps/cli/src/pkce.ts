import { createHash, randomBytes } from "node:crypto";

/**
 * PKCE (Proof Key for Code Exchange, RFC 7636) の verifier / challenge pair を生成する。
 *
 * - verifier: 43-128 文字、 URL-safe base64 (= RFC 7636 4.1)
 * - challenge: SHA-256(verifier) を URL-safe base64 化 (= S256 method、 RFC 7636 4.2)
 *
 * 32 bytes (= 256 bits) random で 43 文字、 推測困難。
 */
export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: "S256";
}

function urlsafeBase64(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePkcePair(): PkcePair {
  const verifierBuf = randomBytes(32);
  const verifier = urlsafeBase64(verifierBuf);
  const hash = createHash("sha256").update(verifier).digest();
  const challenge = urlsafeBase64(hash);
  return { verifier, challenge, method: "S256" };
}
