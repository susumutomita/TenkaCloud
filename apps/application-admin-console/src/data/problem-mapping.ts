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
 * here — with only TYPE-only imports from the leaf `problem-types.ts` module
 * (fully erased at runtime) — this module has no runtime edge to either file,
 * so the cycle is broken. `problems.ts` re-exports these for its existing consumers.
 */

import { analyzeProblemCost, type ProblemCostEstimate } from "@tenkacloud/problem-cost";
import { EXECUTABLE_ENGINE, EXECUTABLE_PROVIDER } from "@tenkacloud/problem-runtime";
import {
  findRuntimeCapability,
  RUNTIME_CAPABILITIES,
} from "@tenkacloud/problem-runtime/capabilities";
import type { ProblemCostEstimateSummary, ProblemDetail, ProblemMetadata } from "./problem-types";

export function metadataRuntimeToSummary(metadata: ProblemMetadata): ProblemDetail["runtime"] {
  const runtime = metadata.runtime;
  if (runtime && "kind" in runtime) {
    return {
      kind: "composite",
      targets: runtime.targets.map(({ id, provider, engine }) => ({ id, provider, engine })),
    };
  }
  return {
    provider: runtime?.provider ?? "aws",
    engine: runtime?.engine ?? "cloudformation",
  };
}

export function metadataToDetail(metadata: ProblemMetadata, templateYaml?: string): ProblemDetail {
  const costEstimate = templateYaml
    ? summarizeProblemCost(analyzeProblemCost(templateYaml))
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
    // 未宣言の legacy 問題は aws/cloudformation で実行する。
    runtime: metadataRuntimeToSummary(metadata),
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
    alwaysOnResources: estimate.alwaysOnWarnings.map((resource) => ({
      logicalId: resource.logicalId,
      resourceType: resource.resourceType,
      riskLevel: resource.riskLevel,
    })),
    unclassifiedResourceTypes: estimate.unclassifiedResourceTypes,
    resourceTypes: [...new Set(estimate.resources.map((resource) => resource.resourceType))].sort(),
  };
}

/** Minimal runtime shape the console projects from `metadata.json`. */
interface ConsoleSingleRuntime {
  readonly provider: string;
  readonly engine: string;
}

type ConsoleRuntime =
  | ConsoleSingleRuntime
  | {
      readonly kind: "composite";
      readonly targets: readonly ConsoleSingleRuntime[];
    };

/**
 * Only an AWS CloudFormation runtime is deployed and cost-analyzed by the
 * console; every other provider/engine is display-only here. Delegates to the
 * `@tenkacloud/problem-runtime` constants so the console's notion of "executable"
 * cannot drift from the deploy worker's.
 */
export function isExecutableProblemRuntime(runtime: ConsoleRuntime): boolean {
  return (
    !("kind" in runtime) &&
    runtime.provider === EXECUTABLE_PROVIDER &&
    runtime.engine === EXECUTABLE_ENGINE
  );
}

/**
 * [#2168] True for a problem delivered as a **local container** (`docker/compose`)
 * through Docker local-play rather than a cloud account. Membership is read from
 * `CONTAINER_RUNTIMES` — the same source of truth the deploy worker uses to reject a
 * cloud deploy of these (`classifyRuntimeSupport` → `"container"`) — so a local-only
 * problem can never be silently treated as cloud-deployable here. Distinct from a
 * adapter-wired cloud provider runtime: a container runtime is
 * intentionally never cloud-executable, whereas a reserved one becomes executable
 * once its adapter ships.
 */
export function isLocalOnlyProblemRuntime(runtime: ConsoleRuntime): boolean {
  if ("kind" in runtime) return false;
  return findRuntimeCapability(runtime.provider, runtime.engine)?.selection === "local-only";
}

/**
 * [#2167, tightened by #2757] The non-AWS providers that are actually deployable
 * end-to-end and therefore become selectable in the event picker once the operator
 * enables multi-cloud (`features.nonAwsRuntime`) and registers that team's cloud
 * credentials. Gated on `capability.executable`, not `capability.adapterWired`:
 * every declared row ships adapter/credential wiring (`adapterWired` is `true` for
 * all of them), but wiring alone does not mean the materialize-and-deploy path is
 * expected to work — `azure/bicep` and `gcp/infra-manager` are adapter-wired
 * previews with `executable: false` (Bicep/Terraform materialization still open),
 * while `sakura/apprun` is `executable: true`. Adapter-wired-but-not-executable
 * rows stay visible in the developer-portal / landing runtime-matrix pages (which
 * read `RUNTIME_CAPABILITIES` directly for their preview surface) but must never
 * reach this picker's "selectable" set. Derived from `RUNTIME_CAPABILITIES`
 * (deduped by provider) so the set tracks the roadmap as engines graduate from
 * preview to executable — there is no second hand-maintained provider list to drift.
 */
export const NON_AWS_SELECTABLE_PROVIDERS: readonly string[] = [
  ...new Set(
    RUNTIME_CAPABILITIES.filter(
      (capability) =>
        capability.executionMode === "cloud" &&
        capability.selection === "feature-gated" &&
        capability.executable,
    ).map((capability) => capability.provider),
  ),
];

/**
 * [#2167, tightened by #2757] Picker selectability — distinct from
 * {@link isExecutableProblemRuntime} (which governs cost analysis, AWS/CloudFormation
 * only). A problem is selectable in the event picker when:
 *   - it is the always-executable AWS/CloudFormation runtime, OR
 *   - it is a recognized, **executable** `(provider, engine)` pair AND that provider is
 *     in `enabledProviders` (today: the whole non-AWS executable set when
 *     `features.nonAwsRuntime` is on; later, the set of providers with registered team
 *     credentials).
 * A provider being enabled does NOT make an unrecognized `(provider, engine)` pair
 * selectable — the engine must still be one the platform has an adapter for, so a
 * typo'd runtime stays disabled rather than offered for a deploy that would fail.
 * Requiring `executable` (rather than just `adapterWired`) additionally keeps a
 * deploy-impossible-but-adapter-wired preview runtime (e.g. `azure/bicep`,
 * `gcp/infra-manager`) disabled here even when its provider is otherwise enabled —
 * that preview-only surface belongs to the developer-portal / landing runtime-matrix
 * pages, not the normal event-creation flow.
 */
export function isProviderSelectable(
  runtime: ConsoleRuntime,
  enabledProviders: ReadonlySet<string>,
): boolean {
  if ("kind" in runtime) {
    return runtime.targets.every((target) => isProviderSelectable(target, enabledProviders));
  }
  if (isExecutableProblemRuntime(runtime)) return true;
  const capability = findRuntimeCapability(runtime.provider, runtime.engine);
  return (
    capability?.executable === true &&
    capability.selection === "feature-gated" &&
    enabledProviders.has(runtime.provider)
  );
}

/** Provider order as authored in metadata, deduplicated for team destination controls. */
export function runtimeProviders(runtime: ConsoleRuntime): readonly string[] {
  const providers =
    "kind" in runtime ? runtime.targets.map((target) => target.provider) : [runtime.provider];
  return [...new Set(providers)];
}

/**
 * [#2167] Resolve the set of selectable non-AWS providers from the multi-cloud
 * feature flag. ON → every provider with a working adapter; OFF → none (AWS stays
 * selectable through {@link isProviderSelectable}). Kept pure so the picker and its
 * tests share one source of truth for "what does the flag turn on".
 */
export function enabledNonAwsProviders(nonAwsRuntimeEnabled: boolean): ReadonlySet<string> {
  return new Set(nonAwsRuntimeEnabled ? NON_AWS_SELECTABLE_PROVIDERS : []);
}
