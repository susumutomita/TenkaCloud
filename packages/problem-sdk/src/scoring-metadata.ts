/**
 * [Problem SDK / Issue #2106 ← ADR-012 Phase 3.B] Pure `metadata.json:scoring`
 * section parsers — the single source of truth shared by the platform (CDK synth
 * `discoverProblemsScoring`, Lambda runtime scoring) and external Pack authoring.
 *
 * `infrastructure/lib/utils/scoring-metadata.ts` re-exports every symbol here so
 * the platform keeps one schema. The env-decoding helpers (`parseScoringEnv`)
 * stay in infra because they depend on `node:zlib`; everything here is pure and
 * deterministic (no I/O, no env, no clock).
 *
 * 6 builtin kinds (ADR-012 Phase 3.B 5 + #1796 multi-flag) + #2070 composite-probe
 * + #2252 multi-verify (local container problems):
 *   - `flag`              — single submission (Challenge, submission scoring)
 *   - `multi-flag`        — N independent flags in one problem, partial points
 *   - `multi-verify`      — N container-judged checkpoints (docker local-play), partial points
 *   - `uptime-flat`       — independent endpoint probes, points when all OK
 *   - `uptime-multi`      — N slots AND-probed, points all OK / failure penalty
 *   - `phased-polling`    — time-based score rules, platform classification + bonus
 *   - `attack-detection`  — counter-delta detection in stack output
 *   - `composite-probe`   — one probe per composite target (#2070)
 *
 * Issue #2225: each kind's types + parser now live in `scoring-metadata/<kind>.ts`
 * (mechanical split, no logic change). This module re-exports every consumed
 * symbol (#2866 dropped the never-imported `MultiVerifyCheck` re-export) and
 * owns only the discriminated union + the `parseScoringMetadata` dispatcher, so
 * every existing import path (`from "./scoring-metadata.js"` /
 * `from "@tenkacloud/problem-sdk"`) is unchanged.
 */

import type { AttackDetectionScoringMetadata } from "./scoring-metadata/attack-detection.js";
import { parseAttackDetection } from "./scoring-metadata/attack-detection.js";
import type { CompositeProbeScoringMetadata } from "./scoring-metadata/composite.js";
import { parseCompositeProbe } from "./scoring-metadata/composite.js";
import type { FlagScoringMetadata } from "./scoring-metadata/flag.js";
import { parseFlag } from "./scoring-metadata/flag.js";
import type { MultiFlagScoringMetadata } from "./scoring-metadata/multi-flag.js";
import { parseMultiFlag } from "./scoring-metadata/multi-flag.js";
import type { MultiVerifyScoringMetadata } from "./scoring-metadata/multi-verify.js";
import { parseMultiVerify } from "./scoring-metadata/multi-verify.js";
import type { PhasedPollingScoringMetadata } from "./scoring-metadata/phased-polling.js";
import { parsePhasedPolling } from "./scoring-metadata/phased-polling.js";
import type {
  UptimeFlatScoringMetadata,
  UptimeMultiScoringMetadata,
} from "./scoring-metadata/uptime.js";
import { parseUptimeFlat, parseUptimeMulti } from "./scoring-metadata/uptime.js";

export type {
  AttackDetectionCategory,
  AttackDetectionScoringMetadata,
} from "./scoring-metadata/attack-detection.js";
export type {
  CompositeProbeScoringMetadata,
  CompositeProbeTarget,
} from "./scoring-metadata/composite.js";
export type { FlagScoringMetadata } from "./scoring-metadata/flag.js";
export type { HintRevealMode, ProgressiveHint } from "./scoring-metadata/hints.js";
export type { MultiFlagEntry, MultiFlagScoringMetadata } from "./scoring-metadata/multi-flag.js";
// `MultiVerifyCheck` is deliberately not re-exported: the platform never scores
// multi-verify (container-judged, scripts/local-play only), so no consumer names
// the check type — reach it as `MultiVerifyScoringMetadata["checks"][number]` (#2866).
export type { MultiVerifyScoringMetadata } from "./scoring-metadata/multi-verify.js";
export type {
  PhasedPollingBonus,
  PhasedPollingPlatformRule,
  PhasedPollingResponsePenalty,
  PhasedPollingScoringMetadata,
} from "./scoring-metadata/phased-polling.js";
export type {
  UptimeFlatEndpoint,
  UptimeFlatScoringMetadata,
  UptimeMultiProbedSlot,
  UptimeMultiScoringMetadata,
} from "./scoring-metadata/uptime.js";

/**
 * The validated `metadata.json:scoring` section: a discriminated union over the
 * built-in scoring kinds (`flag` / `multi-flag` / `uptime-flat` (+ legacy
 * `uptime`) / `uptime-multi` / `phased-polling` / `attack-detection` /
 * `composite-probe`), keyed by `kind`. Serializable — it is exactly the shape an
 * author writes and the scoring engine reads.
 */
export type ProblemScoringMetadata =
  | FlagScoringMetadata
  | MultiFlagScoringMetadata
  | MultiVerifyScoringMetadata
  | UptimeFlatScoringMetadata
  | UptimeMultiScoringMetadata
  | PhasedPollingScoringMetadata
  | AttackDetectionScoringMetadata
  | CompositeProbeScoringMetadata;

/**
 * Narrow one `scoring` value to {@link ProblemScoringMetadata}, or `undefined`
 * when malformed. Legacy `kind: "uptime"` normalizes to `uptime-flat` semantics
 * while preserving the literal so legacy metadata views stay compatible.
 */
export function parseScoringMetadata(value: unknown): ProblemScoringMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { kind?: unknown };
  if (v.kind === "flag") return parseFlag(value);
  if (v.kind === "multi-flag") return parseMultiFlag(value);
  if (v.kind === "multi-verify") return parseMultiVerify(value);
  if (v.kind === "uptime" || v.kind === "uptime-flat") return parseUptimeFlat(value, v.kind);
  if (v.kind === "uptime-multi") return parseUptimeMulti(value);
  if (v.kind === "phased-polling") return parsePhasedPolling(value);
  if (v.kind === "attack-detection") return parseAttackDetection(value);
  if (v.kind === "composite-probe") return parseCompositeProbe(value);
  return undefined;
}
