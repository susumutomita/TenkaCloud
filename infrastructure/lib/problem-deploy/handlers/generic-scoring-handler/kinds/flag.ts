import { createHash, timingSafeEqual } from "node:crypto";
import type { KindHandlerInput, KindResult } from "../scoring-kernel.js";
import { noopKindResult } from "../scoring-kernel.js";

/**
 * `flag` kind。
 *
 * **採点は polling 経由では行わない**。Challenge の flag 提出は POST `/portal/me/.../submit-flag`
 * で event-triggered に走り、`participant-handler/submit-flag.ts` が一致比較 + 加点 + score
 * event 行 write を atomic に実行する。
 *
 * 本 dispatcher は flag kind を **no-op** として扱う (= scoreDelta=0)。`flagMatches` だけ
 * shared helper として export し、`submit-flag.ts` と test が同 logic を共有することで
 * dedup する。
 */

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

export function runFlagKind(_input: KindHandlerInput): KindResult {
  // flag 採点は submit-flag (= POST trigger) 経路に任せる。polling 経路では何もしない。
  return noopKindResult();
}
