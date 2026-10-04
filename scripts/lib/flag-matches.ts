import { createHash, timingSafeEqual } from "node:crypto";

/**
 * 競技者 input と stack output 値を比較。両端 trim、case-sensitive。
 *
 * 比較は定数時間で行う: 両値を SHA-256 で固定長 digest にしてから `timingSafeEqual`
 * する。 素の `===` は先頭不一致で短絡し、 応答時間に「一致 prefix 長」が漏れる
 * timing oracle になる (= flag を 1 文字ずつ探れる)。 digest 化で入力長も隠れる。
 * packages/trust-bridge の digest 照合と同方針。
 */
export function flagMatches(submitted: string, expected: string): boolean {
  const submittedDigest = createHash("sha256").update(submitted.trim(), "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected.trim(), "utf8").digest();
  return timingSafeEqual(submittedDigest, expectedDigest);
}
