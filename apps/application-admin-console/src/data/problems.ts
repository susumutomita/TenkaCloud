/**
 * 問題カタログ。`problems/` ディレクトリの metadata.json を Vite の `import.meta.glob`
 * で build 時に取り込む。問題を追加するときは `problems/<category>/<id>/{template.yaml,
 * metadata.json}` を置くだけで、本ファイルへの手作業は不要。
 *
 * Phase 2 (ADR-003) で問題カタログを DDB-backed の API に置き換える予定。それまでは
 * 静的 build-time discovery で 1 元化を保つ。
 */

import type { CostRiskLevel } from "../../../../scripts/lib/problem-cost";
import {
  buildEffectiveCatalog,
  type CoreCatalogInput,
  type PackCatalogProblemInput,
} from "./effective-catalog";

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
} from "./problem-mapping";

export type ProblemCategory = "Battle" | "Challenge";
export type ProblemStatus = "ready" | "draft" | "deprecated";

export interface ProblemCostResourceSummary {
  readonly logicalId: string;
  readonly resourceType: string;
  readonly roughHourlyUsd: number;
  readonly riskLevel: CostRiskLevel;
}

export interface ProblemCostEstimateSummary {
  readonly totalHourlyUsd: number;
  readonly perSessionUsd: number | undefined;
  readonly perDayIfLeftRunningUsd: number;
  readonly alwaysOnResources: readonly ProblemCostResourceSummary[];
  readonly unpricedResourceTypes: readonly string[];
  readonly resourceTypes: readonly string[];
}

export interface ProblemSummary {
  id: string;
  name: string;
  category: ProblemCategory;
  status: ProblemStatus;
  /** カード表示用の 1 行サマリ */
  shortDescription: string;
  /** 想定難易度 (1=入門 / 5=エキスパート) */
  difficulty: 1 | 2 | 3 | 4 | 5;
  /** 想定プレイ時間 */
  estimatedDuration: string;
  tags: readonly string[];
  /**
   * Issue #1201: 問題作成者が宣言する推奨 deploy 先 region。 EventCreate wizard が
   * 各問題行の region 初期値として採用する。 未宣言なら従来通り
   * `DEFAULT_AWS_REGION` にフォールバック。 operator は wizard で override 可能。
   */
  defaultRegion?: string;
  /**
   * Issue #1201 Phase 2: 動作確認済の region 集合。 宣言された場合、 EventCreate
   * wizard の region picker はこの集合だけを選択肢として出す (= 動かない region への
   * misconfig 予防)。 `defaultRegion` はこの集合に含まれていることを validator が保証。
   * 未宣言なら全 AWS region から選べる (= 後方互換)。
   */
  supportedRegions?: readonly string[];
  /** ADR-026 / ADR-027: 問題が deploy される cloud (provider) と engine。 未宣言は aws/cloudformation。 */
  runtime: { readonly provider: string; readonly engine: string };
  /**
   * Issue #1776: `metadata.json` の `scoring.kind` (ADR-012 の 5 builtin kind:
   * flag / uptime-flat / uptime-multi / phased-polling / attack-detection)。
   * scoring 未宣言 (= deploy のみで競技要素なし) は undefined。 カタログ絞り込みの facet に使う。
   */
  scoringKind?: string;
  /** Issue #1910: template.yaml から導出した offline cost-risk estimate。 */
  costEstimate?: ProblemCostEstimateSummary;
  /**
   * Issue #2093: EFFECTIVE catalog provenance — display-only metadata, populated
   * ONLY when a problem comes from an installed pack snapshot. Core problems leave
   * these undefined so the legacy core-only UI is byte-identical (no pack labels).
   * Provenance is NEVER an authorization input; the console only renders it.
   */
  source?: "core" | "pack";
  /** Reverse-DNS pack id of the contributing pack (pack problems only). */
  packId?: string;
  /** Stamped SemVer of the contributing pack (pack problems only). */
  packVersion?: string;
  /** SPDX-ish license string declared by the contributing pack (pack problems only). */
  license?: string;
}

export interface ProblemDetail extends ProblemSummary {
  /** Markdown 風の長文 (改行 OK)。詳細ページに丸ごと表示する */
  description: string;
  /** 参加者がアクセスする想定ポート */
  exposedPorts: readonly { port: number; name: string }[];
  /** 学習目的 (シナリオ作者からのねらい) */
  learningGoals: readonly string[];
}

/**
 * `problems/<category>/<id>/metadata.json` の生 shape。`problems/SCHEMA.json` と一致。
 * UI で使わない field (`cfnTemplate` / `cfnParameters`) も型として定義しておくが
 * `ProblemDetail` には map しない。
 */
export interface ProblemMetadata {
  $schema?: string;
  id: string;
  name: string;
  category: ProblemCategory;
  status: ProblemStatus;
  difficulty: 1 | 2 | 3 | 4 | 5;
  estimatedDuration: string;
  shortDescription: string;
  description: string;
  tags: string[];
  exposedPorts: { port: number; name: string }[];
  learningGoals: string[];
  cfnTemplate: string;
  cfnParameters?: Record<string, string>;
  /** ADR-026 / ADR-027: 問題の実行環境 (provider/engine)。 未宣言は aws/cloudformation 既定。 */
  runtime?: { provider?: string; engine?: string; entry?: string };
  /**
   * ADR-012: scoring 宣言。 UI が使うのは `kind` のみ (kind は schema 上 scoring 内で必須)。
   * 配点詳細 (points / flagOutputKey 等) は backend の責務なので型として持たない。
   */
  scoring?: { kind: string };
  /** Issue #1201: 問題作成者宣言の推奨 region。 wizard が初期値に使う。 */
  defaultRegion?: string;
  /** Issue #1201 Phase 2: 動作確認済 region 集合。 wizard が picker の選択肢を絞る。 */
  supportedRegions?: string[];
}

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
  const templateName = metadata.runtime?.entry ?? metadata.cfnTemplate;
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
 * ADR-026 / ADR-027: 問題の deploy 先 cloud の表示名 (brand 名なので locale 非依存)。
 * 未知 provider は raw 値をそのまま出す (= 新 provider 追加時の安全側 fallback)。
 */
export const PROVIDER_LABEL: Record<string, string> = {
  aws: "AWS",
  sakura: "Sakura Cloud",
  azure: "Azure",
  gcp: "Google Cloud",
};
