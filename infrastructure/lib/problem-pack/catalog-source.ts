/**
 * [Problem Packs / Issue #2092] Catalog SOURCE ABSTRACTION for backend deploy paths.
 *
 * Backend deployment paths (deploy handler, scoring, endpoints, phases, visibility,
 * disruptions, coordination, runtime lookup) consume ONE effective catalog object —
 * the {@link ProblemsCatalogBundle} — instead of depending DIRECTLY on the single
 * local `problems/` tree. This module introduces that seam:
 *
 *   - {@link CatalogSource} is the interface the catalog resolution layer
 *     (`app-config/resolve.ts`) talks to. It hands back a `ProblemsCatalogBundle`
 *     (the nine projections the backend stacks already wire in) plus per-problem
 *     source provenance kept SEPARATE from the bundle so legacy rows are unchanged.
 *
 *   - {@link LocalCatalogSource} preserves the EXACT current synth-time behavior:
 *     it calls the same `discoverProblems*` extractors and `bundleCoordinationPlugins`
 *     in the same order over the same local `problems/` root, so its bundle is
 *     byte-identical to the legacy `discoverAppProblems` path. This is the DEFAULT
 *     source — the default code path stays byte-identical (CFn NO-OP).
 *
 *   - {@link SnapshotCatalogSource} composes the local core catalog with already
 *     validated installed pack snapshots through the pure {@link composeEffectiveCatalog}
 *     composer (#2091). It is ADDED but NOT ACTIVATED by default: nothing wires it
 *     into `resolve.ts`, and with no installed snapshots it produces a bundle deeply
 *     equal to {@link LocalCatalogSource}'s — so it is dormant until a later issue
 *     turns it on. Duplicate ids / unavailable runtimes fail closed (loudly), never
 *     a silent fallback. There is NO remote fetch here — snapshots are loaded
 *     upstream (#2090) and passed in already validated.
 */

import type { ProblemsCatalogBundle } from "../app-config/types.js";
import { bundleCoordinationPlugins } from "../utils/bundle-coordination-plugins.js";
import {
  discoverProblemsCatalog,
  discoverProblemsCoordination,
  discoverProblemsDisruptions,
  discoverProblemsEndpoints,
  discoverProblemsPhases,
  discoverProblemsRuntime,
  discoverProblemsScoring,
  discoverProblemsVisibility,
  discoverProblemsWriteups,
} from "../utils/discover-problems-catalog.js";
import {
  composeEffectiveCatalog,
  type EffectiveCatalogProvenance,
  type PackSnapshotInput,
} from "./effective-catalog.js";
import type { ProviderEngineCapability } from "./manifest.js";

/** Per-problem provenance map: which source contributed each problem id. */
export type CatalogProvenanceMap = Readonly<Record<string, EffectiveCatalogProvenance>>;

/**
 * A source of the effective catalog the backend deployment paths consume.
 *
 * `loadBundle` returns the {@link ProblemsCatalogBundle} (the nine projections the
 * backend stacks wire in) for a given local `problems/` root. `describeProvenance`
 * returns the per-problem source identity SEPARATELY, so consumers that want
 * provenance can ask for it without it ever altering the bundle shape that flows
 * into CDK / Lambda env vars.
 */
export interface CatalogSource {
  /** Build the effective catalog bundle for the given local `problems/` root. */
  loadBundle(problemsRoot: string): ProblemsCatalogBundle;
  /** Per-problem provenance, kept out of the bundle so legacy rows stay unchanged. */
  describeProvenance(problemsRoot: string): CatalogProvenanceMap;
}

/**
 * The default source: the local `problems/` tree, byte-identical to the legacy
 * `discoverAppProblems` discovery. It runs the SAME extractors in the SAME order so
 * the synth-time output (catalog / scoring / endpoints / phases / visibility /
 * runtimes / disruptions / coordination / coordinationBundles) is unchanged. Every
 * local problem's provenance is `{ source: "core" }`.
 */
export class LocalCatalogSource implements CatalogSource {
  loadBundle(problemsRoot: string): ProblemsCatalogBundle {
    return {
      catalog: discoverProblemsCatalog(problemsRoot),
      scoring: discoverProblemsScoring(problemsRoot),
      writeups: discoverProblemsWriteups(problemsRoot),
      endpoints: discoverProblemsEndpoints(problemsRoot),
      phases: discoverProblemsPhases(problemsRoot),
      visibility: discoverProblemsVisibility(problemsRoot),
      runtimes: discoverProblemsRuntime(problemsRoot),
      disruptions: discoverProblemsDisruptions(problemsRoot),
      coordination: discoverProblemsCoordination(problemsRoot),
      // ADR-030 Phase 3b: synth 時に coordination plugin を self-contained .mjs へ bundle (esbuild)。
      coordinationBundles: bundleCoordinationPlugins(problemsRoot),
    };
  }

  describeProvenance(problemsRoot: string): CatalogProvenanceMap {
    const provenance: Record<string, EffectiveCatalogProvenance> = {};
    for (const problemId of Object.keys(discoverProblemsCatalog(problemsRoot))) {
      provenance[problemId] = { source: "core" };
    }
    return provenance;
  }
}

/** The platform context installed snapshots are validated against before merge. */
export interface SnapshotCatalogPlatform {
  /** Exact SemVer of the running platform core (e.g. `1.4.0`). Defaults to `1.0.0`. */
  readonly coreVersion?: string;
  /** Provider/engine capabilities the platform can satisfy. Defaults to AWS CloudFormation. */
  readonly availableRuntimes?: readonly ProviderEngineCapability[];
}

/** Options for {@link SnapshotCatalogSource}. */
export interface SnapshotCatalogSourceOptions {
  /**
   * Already-validated installed pack snapshots (#2090 install, #2088 validate). The
   * snapshot adapter does NO discovery or remote fetch of its own — it composes
   * what the installer hands it. An empty array means "core only" (dormant).
   */
  readonly snapshots: readonly PackSnapshotInput[];
  /** Platform context for manifest core-range / runtime-capability validation. */
  readonly platform?: SnapshotCatalogPlatform;
}

/** Inert default platform: satisfies core-only / AWS reference packs, no remote reach. */
const DEFAULT_PLATFORM_CORE_VERSION = "1.0.0";
const DEFAULT_PLATFORM_RUNTIMES: readonly ProviderEngineCapability[] = [
  { provider: "aws", engine: "cloudformation" },
];

/**
 * A catalog source that composes the local core catalog with installed pack
 * snapshots via the pure {@link composeEffectiveCatalog}. ADDED but NOT ACTIVATED:
 * nothing wires it into `resolve.ts`. With `snapshots: []` it is byte-identical to
 * {@link LocalCatalogSource}, so it stays dormant until a later issue activates it.
 *
 * On a fail-closed composition (duplicate id across core/pack, unavailable runtime,
 * unsatisfied core range) it THROWS loudly — never a silent mock / empty fallback.
 */
export class SnapshotCatalogSource implements CatalogSource {
  private readonly local = new LocalCatalogSource();

  constructor(private readonly options: SnapshotCatalogSourceOptions) {}

  loadBundle(problemsRoot: string): ProblemsCatalogBundle {
    const coreBundle = this.local.loadBundle(problemsRoot);
    // Dormant fast-path: with no installed snapshots the composed catalog is exactly
    // the core catalog, so the default code path is byte-identical.
    if (this.options.snapshots.length === 0) return coreBundle;

    // Validate the composition (and surface a fail-closed conflict) before merging
    // the pack catalog entries onto the legacy core projections.
    const result = composeEffectiveCatalog({
      core: Object.entries(coreBundle.catalog as Record<string, string>).map(
        ([problemId, directory]) => ({ problemId, directory, projections: {} }),
      ),
      packs: this.options.snapshots,
      platform: this.resolvePlatform(),
    });
    if (!result.ok) {
      throw new Error(`[SnapshotCatalogSource] ${result.reason}: ${result.message}`);
    }

    // Legacy core projections flow through UNCHANGED. Pack problems are additive.
    // ADR-028/030 activation (#2323): a pack that declares `interTeamCoordination.plugin`
    // now has its coordination projection reach the effective bundle — mirroring how the
    // catalog directory map is already merged — so it flows on to the coordination
    // dispatcher (props → CoordinationDispatcherLambda / CoordinationPluginBundle) instead
    // of going inert once installed as a snapshot. Two projection keys are carried, matching
    // the core shapes:
    //   - `coordination`       → `{ plugin }`  (same value shape as `discoverProblemsCoordination`)
    //   - `coordinationBundle` → the self-contained `.mjs` text (one entry of `bundleCoordinationPlugins`)
    // Scoring / endpoints / etc. for a pack remain a later issue's concern, so their legacy
    // rows still never change here.
    const packCatalog: Record<string, string> = {};
    const packCoordination: Record<string, unknown> = {};
    const packCoordinationBundles: Record<string, string> = {};
    for (const entry of result.entries) {
      if (entry.provenance.source !== "pack") continue;
      packCatalog[entry.problemId] = entry.directory;
      // `projections` is the untyped ({@link composeEffectiveCatalog} passes it through
      // verbatim) vehicle carrying the pack's per-problem coordination declaration + its
      // synth-bundled plugin. Absent keys mean "no coordination" (not an error), so a pack
      // without coordination contributes nothing and the core rows stay byte-identical.
      const coordination = (entry.projections as { coordination?: unknown }).coordination;
      if (coordination !== undefined) packCoordination[entry.problemId] = coordination;
      const coordinationBundle = (entry.projections as { coordinationBundle?: unknown })
        .coordinationBundle;
      if (typeof coordinationBundle === "string") {
        packCoordinationBundles[entry.problemId] = coordinationBundle;
      }
    }
    return {
      ...coreBundle,
      catalog: { ...(coreBundle.catalog as Record<string, string>), ...packCatalog },
      // Pack coordination is spread ON TOP of the core projections (`{ ...core, ...pack }`),
      // never replacing them — packs cannot override core (compose already fails closed on a
      // duplicate id). With no pack coordination both spreads are `{ ...core }` (deep-equal to
      // today's bundle = NO-OP).
      coordination: {
        ...(coreBundle.coordination as Record<string, unknown>),
        ...packCoordination,
      },
      coordinationBundles: {
        ...(coreBundle.coordinationBundles as Record<string, string>),
        ...packCoordinationBundles,
      },
    };
  }

  describeProvenance(problemsRoot: string): CatalogProvenanceMap {
    const coreBundle = this.local.loadBundle(problemsRoot);
    const result = composeEffectiveCatalog({
      core: Object.entries(coreBundle.catalog as Record<string, string>).map(
        ([problemId, directory]) => ({ problemId, directory, projections: {} }),
      ),
      packs: this.options.snapshots,
      platform: this.resolvePlatform(),
    });
    if (!result.ok) {
      throw new Error(`[SnapshotCatalogSource] ${result.reason}: ${result.message}`);
    }
    const provenance: Record<string, EffectiveCatalogProvenance> = {};
    for (const entry of result.entries) provenance[entry.problemId] = entry.provenance;
    return provenance;
  }

  private resolvePlatform() {
    return {
      coreVersion: this.options.platform?.coreVersion ?? DEFAULT_PLATFORM_CORE_VERSION,
      availableRuntimes: this.options.platform?.availableRuntimes ?? DEFAULT_PLATFORM_RUNTIMES,
    };
  }
}
