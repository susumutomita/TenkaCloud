/**
 * [Problem Test Harness / Issue #2107] Scoring-kind narrowings derived from the
 * PUBLIC `@tenkacloud/problem-sdk` union.
 *
 * The public SDK exports the discriminated union `ProblemScoringMetadata` but
 * keeps the per-kind member interfaces out of its public surface. The harness
 * only needs the per-kind shapes to dispatch the scorer, so it derives them from
 * the public union with `Extract` rather than reaching into the Core-only
 * `/internal` entrypoint. This keeps the harness on the supported authoring
 * contract and means a single source of truth for the scoring schema (the SDK).
 */

import type { ProblemScoringMetadata } from "@tenkacloud/problem-sdk";

export type { ProblemScoringMetadata } from "@tenkacloud/problem-sdk";
export type { FakeProbeResult, HarnessDiagnostic, ScoreOutcome } from "./types.js";

type ByKind<K extends ProblemScoringMetadata["kind"]> = Extract<
  ProblemScoringMetadata,
  { kind: K }
>;

export type FlagScoringMetadata = ByKind<"flag">;
export type MultiFlagScoringMetadata = ByKind<"multi-flag">;
export type UptimeFlatScoringMetadata = ByKind<"uptime-flat" | "uptime">;
export type UptimeMultiScoringMetadata = ByKind<"uptime-multi">;
export type PhasedPollingScoringMetadata = ByKind<"phased-polling">;
export type AttackDetectionScoringMetadata = ByKind<"attack-detection">;
export type CompositeProbeScoringMetadata = ByKind<"composite-probe">;

/** One composite-probe target, narrowed from the public union member. */
export type CompositeProbeTarget = CompositeProbeScoringMetadata["targets"][number];
