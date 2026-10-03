import type { DeployContext } from "../deploy-handler/deploy.js";
import type { EventSharedResources } from "../event-handler/shared.js";
import {
  captureCurrentCatalog,
  currentCatalogKey,
  loadSavedCatalog,
  type ResolvedExecutionCatalog,
} from "./execution-catalog.js";
import {
  makeProblemRuntimeDescriptorResolver,
  makeProblemRuntimeResolver,
} from "./runtime/index.js";

/** Legacy injected/local contexts stay usable; configured cloud writes require a verified pin. */
export function executionCatalogConfigured(): boolean {
  return Boolean(
    currentCatalogKey() ||
      process.env.CLOUD_ARTIFACT_BUCKET ||
      process.env.CLOUD_LEGACY_CATALOG_KEY,
  );
}

export async function captureDeploymentCatalog(ctx: DeployContext): Promise<DeployContext> {
  if (ctx.executionCatalog || !executionCatalogConfigured()) return ctx;
  return deploymentCatalogContext(ctx, await captureCurrentCatalog());
}

export function deploymentCatalogContext(
  ctx: DeployContext,
  catalog: ResolvedExecutionCatalog,
): DeployContext {
  return {
    ...ctx,
    executionCatalog: catalog,
    problemsCatalog: catalog.catalog,
    problemsVisibility: catalog.visibility as DeployContext["problemsVisibility"],
    resolveProblemRuntime: makeProblemRuntimeResolver(JSON.stringify(catalog.runtimes)),
    resolveProblemRuntimeDescriptor: makeProblemRuntimeDescriptorResolver(
      JSON.stringify(catalog.runtimes),
    ),
  };
}

export async function savedExecutionCatalog(
  catalogKey: string | undefined,
): Promise<ResolvedExecutionCatalog | undefined> {
  if (!catalogKey && !executionCatalogConfigured()) return undefined;
  try {
    return await loadSavedCatalog(catalogKey);
  } catch (cause) {
    throw new ExecutionCatalogUnavailableError(cause);
  }
}

export function eventCatalogContext(
  shared: EventSharedResources,
  catalog: ResolvedExecutionCatalog,
): EventSharedResources {
  return {
    ...shared,
    executionCatalog: catalog,
    problemsCatalog: catalog.catalog,
    problemsCoordination: catalog.coordination,
    problemsProvenance: catalog.provenance as EventSharedResources["problemsProvenance"],
    problemsDisruptions: catalog.disruptions as EventSharedResources["problemsDisruptions"],
    resolveProblemRuntimeDescriptor: makeProblemRuntimeDescriptorResolver(
      JSON.stringify(catalog.runtimes),
    ),
    // A resolver captured from the current process cannot override event A's provenance.
    resolveDeploymentProvenance: undefined,
  };
}

export function executionDispatchFields(catalog: ResolvedExecutionCatalog | undefined): {
  readonly catalogKey?: string;
  readonly sourceVersion?: string;
  readonly sourceLocation?: string;
} {
  return catalog
    ? {
        catalogKey: catalog.catalogKey,
        sourceVersion: catalog.sourceArchive.versionId,
        sourceLocation: `${catalog.sourceArchive.bucket}/${catalog.sourceArchive.key}`,
      }
    : {};
}

export function isNativeExecutionProblem(
  catalog: ResolvedExecutionCatalog | undefined,
  problemId: string,
): boolean {
  return (
    catalog?.nativeProblems?.some(
      (problem) => problem.problemId === problemId && problem.kind === "coordination",
    ) ?? false
  );
}

export class ExecutionCatalogUnavailableError extends Error {
  readonly code = "execution_catalog_unavailable";
  constructor(cause: unknown) {
    super(
      `Saved execution catalog is unavailable; restore its verified artifacts before retrying. ${cause instanceof Error ? cause.message : ""}`,
      { cause },
    );
    this.name = "ExecutionCatalogUnavailableError";
  }
}
