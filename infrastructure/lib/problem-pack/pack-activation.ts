/**
 * [Problem Packs / Issue #2095] Per-tenant activation of immutable pack revisions
 * and catalog-snapshot pinning for events.
 *
 * This module turns the offline snapshot store (#2090 install, #2094 lifecycle)
 * into a per-tenant catalog model. It owns two concerns — activation and the
 * tenant effective catalog — built on top of the existing pieces and WITHOUT
 * touching the manifest / validator / metadata / diagnostics modules. The
 * immutable event pin + deployment provenance live in the sibling
 * {@link ./event-pin.ts} module.
 *
 *   1. Activation. {@link ActivationStore} records which IMMUTABLE pack revisions
 *      (`packId` + `version` + `contentDigest`) are active for which tenant. An
 *      activation references the exact installed lock entry's digest — never a
 *      mutable remote ref. Activating a revision whose digest does not match the
 *      installed lock entry fails closed; a revision that is not installed fails
 *      closed. Duplicate problem ids across a tenant's active set fail BEFORE the
 *      activation is recorded.
 *
 *   2. Tenant effective catalog. {@link composeTenantEffectiveCatalog} composes
 *      the local core catalog with ONLY the active pack revisions of ONE tenant,
 *      so an inactive pack is invisible and an active pack appears only for its
 *      tenant. A core-only tenant (no activations) yields exactly the core
 *      catalog, so existing single-tenant behavior is unchanged. The tenant
 *      effective catalog is also exposed as a {@link CatalogSource} via
 *      {@link tenantCatalogSource} for the backend deploy paths.
 *
 * Determinism + purity discipline (carried over from the dependencies):
 *   - the catalog composer it delegates to (#2091) is pure; the store here does
 *     only LOCAL filesystem I/O over the snapshot-store root, no clock / cloud;
 *   - every external boundary (the on-disk activation records) is parsed with
 *     Zod, so malformed state fails loudly rather than silently degrading.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { PackAsset } from "../app-config/types.js";
import { bundleCoordinationPlugins } from "../utils/bundle-coordination-plugins.js";
import {
  discoverProblemsCoordination,
  discoverProblemsDisruptions,
  discoverProblemsEndpoints,
  discoverProblemsPhases,
  discoverProblemsRuntime,
  discoverProblemsScoring,
  discoverProblemsVisibility,
  discoverProblemsWriteups,
} from "../utils/discover-problems-catalog.js";
import { type CatalogSource, SnapshotCatalogSource } from "./catalog-source.js";
import {
  type ComposeEffectiveCatalogResult,
  type CoreProblemInput,
  composeEffectiveCatalog,
  type PackSnapshotInput,
  type PlatformContext,
} from "./effective-catalog.js";
import type { PackManifest } from "./manifest.js";
import { type PackLockEntry, readLock } from "./snapshot.js";
import { validatePackDirectory } from "./validate-pack.js";

/** The activation file at the root of a snapshot store. Records active revisions. */
export const ACTIVATIONS_FILENAME = "pack-activations.json";

/**
 * One activation: an immutable pack revision (id + version + digest) made active
 * for one tenant. The digest pins the EXACT installed content — there is no
 * mutable remote ref here, by construction.
 */
export interface ActivationRecord {
  readonly tenantId: string;
  readonly packId: string;
  readonly version: string;
  readonly contentDigest: string;
}

const ActivationRecordSchema = z
  .object({
    tenantId: z.string().min(1),
    packId: z.string().min(1),
    version: z.string().min(1),
    contentDigest: z.string().min(1),
  })
  .strict();

const ActivationFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    activations: z.array(ActivationRecordSchema),
  })
  .strict();

/** Stable failure reasons for {@link ActivationStore.activate}. */
export type ActivateFailureReason =
  | "NOT_INSTALLED"
  | "DIGEST_MISMATCH"
  | "DUPLICATE_PROBLEM_ID"
  | "RUNTIME_UNAVAILABLE"
  | "CORE_RANGE_UNSATISFIED";

/** Discriminated result of {@link ActivationStore.activate}. Never throws. */
export type ActivateResult =
  | { readonly ok: true; readonly record: ActivationRecord; readonly alreadyActive: boolean }
  | { readonly ok: false; readonly reason: ActivateFailureReason; readonly message: string };

/** Stable failure reasons for {@link ActivationStore.deactivate}. */
export type DeactivateFailureReason = "NOT_ACTIVE";

/** Discriminated result of {@link ActivationStore.deactivate}. Never throws. */
export type DeactivateResult =
  | { readonly ok: true; readonly record: ActivationRecord }
  | { readonly ok: false; readonly reason: DeactivateFailureReason; readonly message: string };

/** Platform context the activation / pinning checks validate manifests against. */
export type ActivationPlatform = PlatformContext;

/** Default platform context: satisfies AWS reference packs, no remote reach. */
const DEFAULT_PLATFORM: ActivationPlatform = {
  coreVersion: "1.0.0",
  availableRuntimes: [{ provider: "aws", engine: "cloudformation" }],
};

/**
 * Controls how a snapshot is projected into a compose input.
 *
 * `withCoordinationProjection` は既定 false。false のとき snapshot は catalog 行のみを出す
 * (`projections: {}`)。true のとき (= {@link tenantCatalogSource} の deploy / synth 経路) だけ、
 * core catalog と同じ `discoverProblems*` extractor を immutable snapshot dir に回し、scoring /
 * endpoints / phases / runtime / disruptions / writeups / coordination を各 problem の `projections`
 * に載せる。coordination plugin は同時に synth-bundle する。
 *
 * Default false keeps the activate() dry-run and event-pin paths byte-identical: they never run
 * esbuild and never throw, so `activate()` keeps its "never throws" contract.
 */
interface SnapshotInputOptions {
  /** Discover each problem's deploy-time projections, including coordination plugin bundling. */
  readonly withCoordinationProjection?: boolean;
}

/**
 * Read + parse the immutable snapshot of one installed revision into a compose
 * input. Reuses the #2088 validator so it stays in lockstep with what validates;
 * returns undefined when the revision's snapshot is missing or invalid.
 *
 * When `options.withCoordinationProjection` is set, each
 * problem carries the same deploy-time projections the core `problems/` tree would expose:
 * scoring / endpoints / phases / runtimes / disruptions / writeups plus coordination declaration
 * and synth-bundled `.mjs` when present. A broken plugin fails loud at synth (esbuild throws) —
 * never a silent drop. With the option off nothing is discovered / bundled at all.
 */
function loadSnapshotInput(
  storeDir: string,
  entry: PackLockEntry,
  options: SnapshotInputOptions = {},
): PackSnapshotInput | undefined {
  const snapshotAbs = path.join(storeDir, entry.snapshotPath);
  const validation = validatePackDirectory(snapshotAbs);
  const manifest: PackManifest | undefined = validation.manifest;
  if (!manifest) return undefined;
  const root = manifest.problemsRoot ?? "problems";
  const directoryByProblemId = buildPackProblemDirectoryMap(manifest, validation.problems);
  const snapshotProjections = options.withCoordinationProjection
    ? loadSnapshotProjections(path.join(snapshotAbs, root), manifest)
    : undefined;
  return {
    manifest,
    contentDigest: entry.contentDigest,
    problems: validation.problemIds.map((problemId) => {
      const directory = directoryByProblemId.get(problemId);
      if (!directory) {
        throw new Error(
          `Validated pack '${manifest.id}@${manifest.version}' did not expose a directory for problem '${problemId}'.`,
        );
      }
      return {
        problemId,
        directory,
        projections: snapshotProjections?.[problemId] ?? {},
      };
    }),
  };
}

function buildPackProblemDirectoryMap(
  manifest: PackManifest,
  problems: readonly { readonly id: string; readonly relDir: string }[],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const problem of problems) {
    if (!out.has(problem.id)) {
      out.set(problem.id, buildPackProblemDirectory(manifest, problem.relDir));
    }
  }
  return out;
}

function buildPackProblemDirectory(manifest: PackManifest, packRelativeDir: string): string {
  const problemsRoot = toPosixPath(manifest.problemsRoot ?? "problems").replace(/\/+$/g, "");
  const problemDir = toPosixPath(packRelativeDir);
  const prefix = `${problemsRoot}/`;
  if (!problemDir.startsWith(prefix) || problemDir.length === prefix.length) {
    throw new Error(
      `Validated pack '${manifest.id}@${manifest.version}' returned problem directory '${packRelativeDir}' outside problemsRoot '${manifest.problemsRoot}'.`,
    );
  }
  return path.posix.join(
    "pack-problems",
    manifest.id,
    manifest.version,
    problemDir.slice(prefix.length),
  );
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * problems root 配下の各問題について core と同じ
 * `discoverProblems*` extractor を走らせ、problemId 別の `projections` fragment を返す。各 value
 * の shape は {@link LocalCatalogSource} が core `problems/` に載せるものと同一で、pack 側で独自
 * parse はしない。未宣言の projection はキーごと不在 (呼び出し側で `{}` へ fallback = NO-OP)。
 *
 * `visibility: private` はここで fail-loud にする。packs は private payload 用の presigned delivery 経路に
 * 対応しておらず、黙って public 扱い / 除外をすると payload の露出ポリシーを誤るため。
 */
function loadSnapshotProjections(
  problemsRootAbs: string,
  manifest: PackManifest,
): Record<string, Readonly<Record<string, unknown>>> {
  const visibility = discoverProblemsVisibility(problemsRootAbs);
  for (const problemId of Object.keys(visibility)) {
    throw new Error(
      `[ProblemPackProjection] packId='${manifest.id}' problemId='${problemId}' declares visibility: private, but packs do not support presigned private-payload delivery; refusing to synth (a private problem must not silently become public).`,
    );
  }

  const out: Record<string, Record<string, unknown>> = {};
  mergeProjection(out, "scoring", discoverProblemsScoring(problemsRootAbs));
  mergeProjection(out, "endpoints", discoverProblemsEndpoints(problemsRootAbs));
  mergeProjection(out, "phases", discoverProblemsPhases(problemsRootAbs));
  mergeProjection(out, "runtimes", discoverProblemsRuntime(problemsRootAbs));
  mergeProjection(out, "disruptions", discoverProblemsDisruptions(problemsRootAbs));
  mergeProjection(out, "writeups", discoverProblemsWriteups(problemsRootAbs));

  const coordination = discoverProblemsCoordination(problemsRootAbs);
  const bundles = bundleCoordinationPlugins(problemsRootAbs);
  for (const [problemId, declaration] of Object.entries(coordination)) {
    const projection = projectionFor(out, problemId);
    projection.coordination = declaration;
    const bundle = bundles[problemId];
    if (typeof bundle === "string") projection.coordinationBundle = bundle;
  }
  return out;
}

function mergeProjection(
  out: Record<string, Record<string, unknown>>,
  key: string,
  discovered: Readonly<Record<string, unknown>>,
): void {
  for (const [problemId, value] of Object.entries(discovered)) {
    projectionFor(out, problemId)[key] = value;
  }
}

function projectionFor(
  out: Record<string, Record<string, unknown>>,
  problemId: string,
): Record<string, unknown> {
  out[problemId] ??= {};
  return out[problemId];
}

/**
 * Per-tenant activation repository over the snapshot store. Records which
 * immutable pack revisions are active for which tenant in a Zod-validated JSON
 * file. Only local filesystem I/O — no clock, no cloud.
 */
export interface ActivationStoreOptions {
  /** Platform context the activation dry-run compose validates manifests against. */
  readonly platform?: ActivationPlatform;
  /**
   * Core problem ids the tenant always sees. When given, an activation whose pack
   * declares a problem id already in core fails closed as a duplicate BEFORE the
   * activation is recorded (packs cannot override core, even per-tenant).
   */
  readonly coreProblemIds?: readonly string[];
}

export class ActivationStore {
  private readonly storeDir: string;
  private readonly platform: ActivationPlatform;
  private readonly coreProblemIds: readonly string[];

  constructor(storeDir: string, options: ActivationStoreOptions | ActivationPlatform = {}) {
    this.storeDir = path.resolve(storeDir);
    // Back-compat: a bare PlatformContext (with `coreVersion`) is accepted as the
    // platform, so existing callers keep `new ActivationStore(dir, platform)`.
    const normalized: ActivationStoreOptions =
      "coreVersion" in options ? { platform: options } : options;
    this.platform = normalized.platform ?? DEFAULT_PLATFORM;
    this.coreProblemIds = normalized.coreProblemIds ?? [];
  }

  /** All activation records, in stable order. Reads ONLY the local activation file. */
  list(): readonly ActivationRecord[] {
    return this.read();
  }

  /** The active revisions of ONE tenant, in stable order. */
  listForTenant(tenantId: string): readonly ActivationRecord[] {
    return this.read().filter((record) => record.tenantId === tenantId);
  }

  /**
   * Activate an installed immutable revision for a tenant. Fails closed when the
   * revision is not installed, when the supplied digest disagrees with the
   * installed lock entry (an immutable revision can never silently change), when
   * the pack's required runtime is unavailable / core range unsatisfied, or when
   * the activation would introduce a duplicate problem id into the tenant's
   * effective catalog. The duplicate check runs BEFORE the record is written, so
   * a clashing activation never persists.
   */
  activate(input: {
    readonly tenantId: string;
    readonly packId: string;
    readonly version: string;
    /** Optional expected digest. When given, it must match the installed entry. */
    readonly contentDigest?: string;
  }): ActivateResult {
    const lock = readLock(this.storeDir);
    const entry = lock.packs.find((p) => p.packId === input.packId && p.version === input.version);
    if (!entry) {
      return {
        ok: false,
        reason: "NOT_INSTALLED",
        message: `Pack '${input.packId}@${input.version}' is not installed; install it before activating.`,
      };
    }
    if (input.contentDigest !== undefined && input.contentDigest !== entry.contentDigest) {
      return {
        ok: false,
        reason: "DIGEST_MISMATCH",
        message: `Refusing to activate '${input.packId}@${input.version}': supplied digest ${input.contentDigest} does not match the installed revision ${entry.contentDigest}. An immutable revision cannot change.`,
      };
    }

    const records = this.read();
    const already = records.find(
      (r) =>
        r.tenantId === input.tenantId && r.packId === input.packId && r.version === input.version,
    );
    if (already) {
      // Idempotent: the same revision is already active for this tenant.
      return { ok: true, record: already, alreadyActive: true };
    }

    const next: ActivationRecord = {
      tenantId: input.tenantId,
      packId: input.packId,
      version: input.version,
      contentDigest: entry.contentDigest,
    };

    // Dry-run compose the tenant's catalog WITH the candidate active, so a
    // duplicate problem id / unavailable runtime is caught BEFORE we persist.
    const compose = this.composeFor(lock, [
      ...records.filter((r) => r.tenantId === input.tenantId),
      next,
    ]);
    if (!compose.ok) {
      return { ok: false, reason: compose.reason, message: compose.message };
    }

    this.write([...records, next]);
    return { ok: true, record: next, alreadyActive: false };
  }

  /** Deactivate a tenant's active revision. Returns NOT_ACTIVE when it was not active. */
  deactivate(input: {
    readonly tenantId: string;
    readonly packId: string;
    readonly version: string;
  }): DeactivateResult {
    const records = this.read();
    const record = records.find(
      (r) =>
        r.tenantId === input.tenantId && r.packId === input.packId && r.version === input.version,
    );
    if (!record) {
      return {
        ok: false,
        reason: "NOT_ACTIVE",
        message: `Pack '${input.packId}@${input.version}' is not active for tenant '${input.tenantId}'.`,
      };
    }
    this.write(
      records.filter(
        (r) =>
          !(
            r.tenantId === input.tenantId &&
            r.packId === input.packId &&
            r.version === input.version
          ),
      ),
    );
    return { ok: true, record };
  }

  /** True when `entry` is referenced by ANY tenant's activation (for {@link removePack}). */
  isPinned(entry: PackLockEntry): boolean {
    return this.read().some((r) => r.packId === entry.packId && r.version === entry.version);
  }

  /**
   * Map the tenant's active records onto already-validated compose snapshot inputs.
   *
   * `options.withCoordinationProjection` を渡した経路
   * (= {@link tenantCatalogSource}) だけが pack の coordination plugin を discover + bundle して
   * projections に載せる。既定 (event-pin など) は `projections: {}` で byte-identical。
   */
  snapshotInputsForTenant(
    tenantId: string,
    options: SnapshotInputOptions = {},
  ): readonly PackSnapshotInput[] {
    const lock = readLock(this.storeDir);
    return this.activeSnapshotInputs(lock, this.listForTenant(tenantId), options);
  }

  /**
   * [Problem Packs / Issue #2462] The on-disk {@link PackAsset} descriptors for a tenant's active
   * revisions: the ABSOLUTE problems root of each active pack's immutable snapshot, tagged with the
   * manifest's `id` + `version`. Lite synth turns each into a `BucketDeployment` that materializes
   * `pack-problems/<packId>/<version>/…` into the source bucket — the exact key space
   * {@link buildPackProblemDirectory} emits for the catalog, so the materialized objects line up
   * with the pack catalog directory keys.
   *
   * Reads ONLY the local store. A revision whose snapshot is missing / invalid is skipped, mirroring
   * {@link loadSnapshotInput} on the catalog path (it validates with the SAME {@link validatePackDirectory}),
   * so the asset set and the resolved catalog agree on which packs are present.
   */
  packAssetsForTenant(tenantId: string): readonly PackAsset[] {
    const lock = readLock(this.storeDir);
    const assets: PackAsset[] = [];
    for (const record of this.listForTenant(tenantId)) {
      const entry = lock.packs.find(
        (p) => p.packId === record.packId && p.version === record.version,
      );
      if (!entry) continue;
      const snapshotAbs = path.join(this.storeDir, entry.snapshotPath);
      const manifest = validatePackDirectory(snapshotAbs).manifest;
      if (!manifest) continue;
      const root = manifest.problemsRoot ?? "problems";
      assets.push({
        packId: manifest.id,
        version: manifest.version,
        problemsRootAbs: path.join(snapshotAbs, root),
      });
    }
    return assets;
  }

  private composeFor(
    lock: ReturnType<typeof readLock>,
    records: readonly ActivationRecord[],
  ): Extract<ComposeEffectiveCatalogResult, { ok: false }> | { ok: true } {
    const packs = this.activeSnapshotInputs(lock, records);
    const core: CoreProblemInput[] = this.coreProblemIds.map((problemId) => ({
      problemId,
      directory: problemId,
      projections: {},
    }));
    const result = composeEffectiveCatalog({ core, packs, platform: this.platform });
    if (result.ok) return { ok: true };
    return result;
  }

  private activeSnapshotInputs(
    lock: ReturnType<typeof readLock>,
    records: readonly ActivationRecord[],
    options: SnapshotInputOptions = {},
  ): PackSnapshotInput[] {
    const inputs: PackSnapshotInput[] = [];
    for (const record of records) {
      const entry = lock.packs.find(
        (p) => p.packId === record.packId && p.version === record.version,
      );
      if (!entry) continue;
      const snapshot = loadSnapshotInput(this.storeDir, entry, options);
      if (snapshot) inputs.push(snapshot);
    }
    return inputs;
  }

  private read(): ActivationRecord[] {
    const file = path.join(this.storeDir, ACTIVATIONS_FILENAME);
    if (!fs.existsSync(file)) return [];
    const parsed = ActivationFileSchema.parse(JSON.parse(fs.readFileSync(file, "utf-8")));
    return [...parsed.activations].sort(compareActivation);
  }

  private write(records: readonly ActivationRecord[]): void {
    fs.mkdirSync(this.storeDir, { recursive: true });
    const sorted = [...records].sort(compareActivation);
    const file = path.join(this.storeDir, ACTIVATIONS_FILENAME);
    fs.writeFileSync(
      file,
      `${JSON.stringify({ schemaVersion: 1, activations: sorted }, null, 2)}\n`,
    );
  }
}

/** Stable order: tenant, then pack id, then version. Keeps the file byte-deterministic. */
function compareActivation(a: ActivationRecord, b: ActivationRecord): number {
  return (
    a.tenantId.localeCompare(b.tenantId) ||
    a.packId.localeCompare(b.packId) ||
    a.version.localeCompare(b.version)
  );
}

/**
 * Compose ONE tenant's effective catalog: the local core problems plus ONLY the
 * tenant's active pack revisions. Pure delegation to {@link composeEffectiveCatalog};
 * an inactive pack is simply absent from `activePacks`, so it is invisible. A
 * tenant with no active packs yields exactly the core catalog.
 */
export function composeTenantEffectiveCatalog(input: {
  readonly core: readonly CoreProblemInput[];
  readonly activePacks: readonly PackSnapshotInput[];
  readonly platform: PlatformContext;
}): ComposeEffectiveCatalogResult {
  return composeEffectiveCatalog({
    core: input.core,
    packs: input.activePacks,
    platform: input.platform,
  });
}

/**
 * Build a tenant-scoped {@link CatalogSource}: the local core catalog composed
 * with ONLY the given tenant's active pack revisions (resolved from the store).
 * An inactive pack contributes nothing, so it is invisible; an active pack
 * appears only for the tenant whose store activated it. With no activations the
 * source is byte-identical to {@link LocalCatalogSource}, so a core-only tenant
 * is unchanged. Reads ONLY the local store — no clock, no remote fetch.
 *
 * This is the deploy / synth catalog path, so it opts into
 * coordination projection: an installed + active pack that declares `interTeamCoordination.plugin`
 * has its coordination declaration + synth-bundled `.mjs` carried onto the effective bundle (and on
 * to the coordination dispatcher) instead of going inert once installed as a snapshot. A pack
 * without coordination — and a core-only tenant — stays byte-identical (NO-OP).
 */
export function tenantCatalogSource(
  store: ActivationStore,
  tenantId: string,
  platform: ActivationPlatform = DEFAULT_PLATFORM,
): CatalogSource {
  return new SnapshotCatalogSource({
    snapshots: store.snapshotInputsForTenant(tenantId, { withCoordinationProjection: true }),
    platform,
  });
}
