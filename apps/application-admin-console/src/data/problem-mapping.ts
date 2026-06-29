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

/**
 * ADR-023 D4: only an AWS CloudFormation runtime is deployed/cost-analyzed by the
 * console; every other provider/engine is display-only here.
 */
export function isExecutableProblemRuntime(runtime: {
  readonly provider: string;
  readonly engine: string;
}): boolean {
  return runtime.provider === "aws" && runtime.engine === "cloudformation";
}
