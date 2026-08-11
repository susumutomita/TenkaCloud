/**
 * 問題カタログ。`problems/` ディレクトリの metadata.json を Vite の `import.meta.glob`
 * で build 時に取り込む。問題を追加するときは `problems/<category>/<id>/{template.yaml,
 * metadata.json}` を置くだけで、本ファイルへの手作業は不要。
 *
 * 現在は静的 build-time discovery を正本として両 console の catalog を一元化する。
 */

import type { CoreCatalogInput, PackCatalogProblemInput } from "./effective-catalog";
import { buildEffectiveCatalog } from "./effective-catalog";
import type { ProblemDetail, ProblemMetadata, ProblemSummary } from "./problem-types";

// `metadataToDetail` / `isExecutableProblemRuntime` live in `problem-mapping.ts`
// to avoid a runtime import cycle with `effective-catalog.ts` (see that file).
// Re-exported here so existing `from "./problems"` consumers are unaffected.
export {
  enabledNonAwsProviders,
  isExecutableProblemRuntime,
  isLocalOnlyProblemRuntime,
  isProviderSelectable,
  metadataToDetail,
  NON_AWS_SELECTABLE_PROVIDERS,
  runtimeProviders,
} from "./problem-mapping";

export type {
  ProblemCategory,
  ProblemCostEstimateSummary,
  ProblemDetail,
  ProblemMetadata,
  ProblemRuntimeSummary,
  ProblemStatus,
  ProblemSummary,
} from "./problem-types";

// `import.meta.glob` で repo root の `problems/*/*/metadata.json` を build 時 / HMR 時に
// 全件取り込む。`eager: true` で同期 import (lazy chunk なし)。`{ default: ... }` 構造で
// 返るのでアダプタで剥がす。
const metadataModules = import.meta.glob<{ default: ProblemMetadata }>(
  "../../../../problems/*/*/metadata.json",
  { eager: true },
);
const templateModules = import.meta.glob<string>("../../../../problems/*/*/*.yaml", {
  eager: true,
  import: "default",
  query: "?raw",
});

function findTemplateYaml(
  modules: Record<string, string>,
  metadataPath: string,
  metadata: ProblemMetadata,
): string | undefined {
  // cfnTemplate は SCHEMA 必須 (= validate-problems が保証) なので `?? "template.yaml"` の
  // 最終 fallback は不到達。 dead branch を残さない (coverage gate / simplify)。
  const templateName =
    metadata.runtime && !("kind" in metadata.runtime)
      ? (metadata.runtime.entry ?? metadata.cfnTemplate)
      : metadata.cfnTemplate;
  const templatePath = metadataPath.replace(/metadata\.json$/, templateName);
  return modules[templatePath];
}

/**
 * Issue #2093: installed pack snapshots live under the local pack-store
 * (`.tenkacloud/pack-store/snapshots/<pack>/<rev>/<problemsRoot>/<category>/<id>/`).
 * They are globbed at BUILD time exactly like core — never fetched client-side —
 * so a core-only checkout (no installed snapshots) matches NOTHING and the catalog
 * stays byte-identical to the legacy core-only projection. Each snapshot also
 * carries a `tenkacloud-pack.json` manifest from which the pack identity / license
 * provenance is read.
 */
const packMetadataModules = import.meta.glob<{ default: ProblemMetadata }>(
  "../../../../.tenkacloud/pack-store/snapshots/**/metadata.json",
  { eager: true },
);
const packTemplateModules = import.meta.glob<string>(
  "../../../../.tenkacloud/pack-store/snapshots/**/*.yaml",
  { eager: true, import: "default", query: "?raw" },
);
const packManifestModules = import.meta.glob<{ default: PackManifestShape }>(
  "../../../../.tenkacloud/pack-store/snapshots/**/tenkacloud-pack.json",
  { eager: true },
);

/** The subset of `tenkacloud-pack.json` the console reads for display provenance. */
export interface PackManifestShape {
  id: string;
  version: string;
  license: string;
}

/**
 * Resolve the nearest `tenkacloud-pack.json` for a pack problem's metadata path.
 * Takes the manifest module map explicitly so it is unit-testable with fakes —
 * the build-time pack glob is empty in a core-only checkout, so the production
 * call below never exercises this branch on its own.
 */
export function findPackManifest(
  manifestModules: Record<string, { default: PackManifestShape }>,
  metadataPath: string,
): PackManifestShape | undefined {
  for (const [manifestPath, mod] of Object.entries(manifestModules)) {
    const root = manifestPath.replace(/tenkacloud-pack\.json$/, "");
    if (metadataPath.startsWith(root)) return mod.default;
  }
  return undefined;
}

/** Project the core glob maps into catalog inputs (pure; testable with fakes). */
export function buildCoreInputs(
  metadata: Record<string, { default: ProblemMetadata }>,
  templates: Record<string, string>,
): readonly CoreCatalogInput[] {
  return Object.entries(metadata).map(([metadataPath, mod]) => ({
    metadata: mod.default,
    templateYaml: findTemplateYaml(templates, metadataPath, mod.default),
  }));
}

/**
 * Project the pack-snapshot glob maps into catalog inputs (pure; testable with
 * fakes). Only snapshots that carry a readable manifest become pack problems; a
 * snapshot missing its manifest is skipped rather than mislabeled as core.
 */
export function buildPackInputs(
  metadata: Record<string, { default: ProblemMetadata }>,
  templates: Record<string, string>,
  manifests: Record<string, { default: PackManifestShape }>,
): readonly PackCatalogProblemInput[] {
  return Object.entries(metadata).flatMap(([metadataPath, mod]) => {
    const manifest = findPackManifest(manifests, metadataPath);
    if (!manifest) return [];
    return [
      {
        metadata: mod.default,
        templateYaml: findTemplateYaml(templates, metadataPath, mod.default),
        packId: manifest.id,
        packVersion: manifest.version,
        license: manifest.license,
      },
    ];
  });
}

const coreInputs = buildCoreInputs(metadataModules, templateModules);
const packInputs = buildPackInputs(packMetadataModules, packTemplateModules, packManifestModules);

// 表示順の安定化のため id で sort (buildEffectiveCatalog が担保)。EFFECTIVE catalog は
// core (上記 glob) と installed pack snapshots を #2091 の composer 経由で merge する。
export const PROBLEM_CATALOG: readonly ProblemDetail[] = buildEffectiveCatalog({
  core: coreInputs,
  packs: packInputs,
});

export function findProblem(id: string): ProblemDetail | undefined {
  return PROBLEM_CATALOG.find((p) => p.id === id);
}

/**
 * Issue #2093: pack provenance is sparse — present ONLY for pack problems, so a
 * core-only summary list stays byte-identical to the legacy projection (no pack
 * fields). `ProblemDetail` extends `ProblemSummary`, so the same optional fields
 * carry through unchanged. Extracted to keep {@link listProblemSummaries} simple.
 */
export function packProvenanceFields(
  p: ProblemDetail,
): Partial<Pick<ProblemSummary, "source" | "packId" | "packVersion" | "license">> {
  if (p.source !== "pack") return {};
  return { source: p.source, packId: p.packId, packVersion: p.packVersion, license: p.license };
}

export function listProblemSummaries(): readonly ProblemSummary[] {
  return PROBLEM_CATALOG.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    status: p.status,
    shortDescription: p.shortDescription,
    difficulty: p.difficulty,
    estimatedDuration: p.estimatedDuration,
    tags: p.tags,
    runtime: p.runtime,
    // region / scoring 系は ProblemSummary でも optional。 現状 catalog の全 problem が
    // region と scoring を宣言するため omit 分岐 (= 未宣言 problem) は実データで到達しない
    // (= 将来 problem 用に保持)。 mapping 本体の分岐網羅は metadataToDetail のユニットテストで担保済。
    /* v8 ignore start */
    ...(p.defaultRegion ? { defaultRegion: p.defaultRegion } : {}),
    ...(p.supportedRegions ? { supportedRegions: p.supportedRegions } : {}),
    ...(p.scoringKind ? { scoringKind: p.scoringKind } : {}),
    ...(p.costEstimate ? { costEstimate: p.costEstimate } : {}),
    /* v8 ignore stop */
    ...packProvenanceFields(p),
  }));
}

/**
 * 問題の deploy 先 cloud の表示名。brand 名なので locale 非依存。
 * 未知 provider は raw 値をそのまま出す (= 新 provider 追加時の安全側 fallback)。
 */
export const PROVIDER_LABEL: Record<string, string> = {
  aws: "AWS",
  sakura: "Sakura Cloud",
  azure: "Azure",
  gcp: "Google Cloud",
};
