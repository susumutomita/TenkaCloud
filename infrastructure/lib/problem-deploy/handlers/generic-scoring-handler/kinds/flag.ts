import type { KindHandlerInput, KindResult } from "../shared.js";
import { noopKindResult } from "../shared.js";

/**
 * `flag` kind (ADR-012 Phase 3.B)。
 *
 * **採点は polling 経由では行わない**。Challenge の flag 提出は POST `/portal/me/.../submit-flag`
 * で event-triggered に走り、`participant-handler/submit-flag.ts` が一致比較 + 加点 + score
 * event 行 write を atomic に実行する。
 *
 * 本 dispatcher は flag kind を **no-op** として扱う (= scoreDelta=0)。`flagMatches` だけ
 * shared helper として export し、`submit-flag.ts` と test が同 logic を共有することで
 * dedup する。
 */

/** 競技者 input と stack output 値を比較。両端 trim、case-sensitive。 */
export function flagMatches(submitted: string, expected: string): boolean {
  return submitted.trim() === expected.trim();
}

export function runFlagKind(_input: KindHandlerInput): KindResult {
  // flag 採点は submit-flag (= POST trigger) 経路に任せる。polling 経路では何もしない。
  return noopKindResult();
}
