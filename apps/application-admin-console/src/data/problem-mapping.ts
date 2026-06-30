/**
 * [#2093] Pure `metadata.json` → catalog-detail projection helpers, factored out
 * of `problems.ts` so the EFFECTIVE-catalog composer (`effective-catalog.ts`) can
 * reuse them WITHOUT a runtime import cycle.
 *
 * `problems.ts` eagerly composes its catalog from `effective-catalog.ts`, and the
 * composer needs `metadataToDetail` / `isExecutableProblemRuntime`. Keeping those
 * functions in `problems.ts` made the two modules import each other's VALUES,
 * which crashes under Vite's SSR transform (`Cannot access '__vite_ssr_import__'
 * before initialization`) when the eager top-level compose runs mid-cycle. Living
 * here — with only TYPE-only imports back to `problems.ts` (fully erased at
 * runtime) — this module has no runtime edge to either file, so the cycle is
 * broken. `problems.ts` re-exports these for its existing consumers.
 */

import {
  CONTAINER_RUNTIMES,
  EXECUTABLE_ENGINE,
  EXECUTABLE_PROVIDER,
} from "@tenkacloud/problem-runtime";
import { analyzeProblemCost, type ProblemCostEstimate } from "../../../../scripts/lib/problem-cost";
import type { ProblemCostEstimateSummary, ProblemDetail, ProblemMetadata } from "./problems";

export function metadataToDetail(metadata: ProblemMetadata, templateYaml?: string): ProblemDetail {
  const costEstimate = templateYaml
    ? summarizeProblemCost(analyzeProblemCost(templateYaml, metadata.estimatedDuration))
    : undefined;
  return {
    id: metadata.id,
    name: metadata.name,
    category: metadata.category,
    status: metadata.status,
    shortDescription: metadata.shortDescription,
    difficulty: metadata.difficulty,
    estimatedDuration: metadata.estimatedDuration,
    tags: metadata.tags,
    description: metadata.description,
    exposedPorts: metadata.exposedPorts,
    learningGoals: metadata.learningGoals,
    // ADR-026 / ADR-027: 実行環境。 未宣言の legacy 問題は aws/cloudformation 既定。
    runtime: {
      provider: metadata.runtime?.provider ?? "aws",
      engine: metadata.runtime?.engine ?? "cloudformation",
    },
    ...(metadata.defaultRegion ? { defaultRegion: metadata.defaultRegion } : {}),
    ...(metadata.supportedRegions && metadata.supportedRegions.length > 0
      ? { supportedRegions: metadata.supportedRegions }
      : {}),
    // Issue #1776: scoring.kind をカタログ facet 用に投影。 scoring 未宣言は omit。
    ...(metadata.scoring ? { scoringKind: metadata.scoring.kind } : {}),
    ...(costEstimate ? { costEstimate } : {}),
  };
}

function summarizeProblemCost(estimate: ProblemCostEstimate): ProblemCostEstimateSummary {
  return {
    totalHourlyUsd: estimate.totalHourlyUsd,
    perSessionUsd: estimate.perSessionUsd,
    perDayIfLeftRunningUsd: estimate.perDayIfLeftRunningUsd,
    alwaysOnResources: estimate.alwaysOnWarnings.map((resource) => ({
      logicalId: resource.logicalId,
      resourceType: resource.resourceType,
      roughHourlyUsd: resource.roughHourlyUsd,
      riskLevel: resource.riskLevel,
    })),
    unpricedResourceTypes: estimate.unpricedResourceTypes,
    resourceTypes: [...new Set(estimate.resources.map((resource) => resource.resourceType))].sort(),
  };
}

/** Minimal runtime shape the console projects from `metadata.json`. */
interface ConsoleRuntime {
  readonly provider: string;
  readonly engine: string;
}

/**
 * ADR-023 D4: only an AWS CloudFormation runtime is deployed/cost-analyzed by the
 * console; every other provider/engine is display-only here. Delegates to the
 * `@tenkacloud/problem-runtime` constants so the console's notion of "executable"
 * cannot drift from the deploy worker's.
 */
export function isExecutableProblemRuntime(runtime: ConsoleRuntime): boolean {
  return runtime.provider === EXECUTABLE_PROVIDER && runtime.engine === EXECUTABLE_ENGINE;
}

/**
 * [#2168] True for a problem delivered as a **local container** (`docker/compose`,
 * the ADR-023 local-play path) rather than a cloud account. Membership is read from
 * `CONTAINER_RUNTIMES` — the same source of truth the deploy worker uses to reject a
 * cloud deploy of these (`classifyRuntimeSupport` → `"container"`) — so a local-only
 * problem can never be silently treated as cloud-deployable here. Distinct from a
 * RESERVED (planned-but-not-yet-shipped provider) runtime: a container runtime is
 * intentionally never cloud-executable, whereas a reserved one becomes executable
 * once its adapter ships.
 */
export function isLocalOnlyProblemRuntime(runtime: ConsoleRuntime): boolean {
  return CONTAINER_RUNTIMES.some(
    (r) => r.provider === runtime.provider && r.engine === runtime.engine,
  );
}
