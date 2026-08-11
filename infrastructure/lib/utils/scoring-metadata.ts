/**
 * 問題の `metadata.json:scoring` (Issue #2106)。
 *
 * 純 narrowing parser (`parseScoringMetadata`) と 6+1 種の kind 型は公開 SDK
 * `@tenkacloud/problem-sdk` に単一 source of truth として集約済みで、 同名・同 signature
 * で re-export する。 env decode を伴う `parseScoringEnv` のみ `node:zlib` 依存のため
 * 本 module に残す (= SDK は deterministic / no-zlib を保つ)。 公開面は CDK synth 時
 * (`discoverProblemsScoring`) と Lambda runtime の両方から参照される。
 */

import {
  type ProblemScoringMetadata,
  parseScoringMetadata,
} from "@tenkacloud/problem-sdk/internal";
import { decodeLargeEnvValue } from "./env-encoding.js";

export {
  type AttackDetectionScoringMetadata,
  type CompositeProbeScoringMetadata,
  type CompositeProbeTarget,
  type FlagScoringMetadata,
  type MultiFlagEntry,
  type PhasedPollingScoringMetadata,
  type ProblemScoringMetadata,
  type ProgressiveHint,
  parseScoringMetadata,
  type UptimeFlatEndpoint,
  type UptimeFlatScoringMetadata,
  type UptimeMultiScoringMetadata,
} from "@tenkacloud/problem-sdk/internal";

/**
 * Lambda env (`BATTLE_PROBLEMS_SCORING`) を decode し、`{ [problemId]: ProblemScoringMetadata }`
 * に narrow する。不正な entry (parse 失敗 / non-object / shape mismatch) は drop。
 *
 * Issue #810: 4 KB env-var 上限を回避するため、 CDK 側は gzip+base64 で env に積む
 * (= encodeLargeEnvValue)。 ここで decode → JSON parse する。 旧形式 (= plain JSON)
 * も backward compat で読める (= H4s prefix 判定)。
 */
export function parseScoringEnv(raw: string | undefined): Record<string, ProblemScoringMetadata> {
  const decoded = decodeLargeEnvValue(raw);
  if (!decoded) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, ProblemScoringMetadata> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const cfg = parseScoringMetadata(v);
    if (cfg) out[k] = cfg;
  }
  return out;
}
