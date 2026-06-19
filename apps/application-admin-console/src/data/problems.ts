/**
 * 問題カタログ。`problems/` ディレクトリの metadata.json を Vite の `import.meta.glob`
 * で build 時に取り込む。問題を追加するときは `problems/<category>/<id>/{template.yaml,
 * metadata.json}` を置くだけで、本ファイルへの手作業は不要。
 *
 * Phase 2 (ADR-003) で問題カタログを DDB-backed の API に置き換える予定。それまでは
 * 静的 build-time discovery で 1 元化を保つ。
 */

import {
  analyzeProblemCost,
  type CostRiskLevel,
  type ProblemCostEstimate,
} from "../../../../scripts/lib/problem-cost";

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

function findTemplateYaml(metadataPath: string, metadata: ProblemMetadata): string | undefined {
  // cfnTemplate は SCHEMA 必須 (= validate-problems が保証) なので `?? "template.yaml"` の
  // 最終 fallback は不到達。 dead branch を残さない (coverage gate / simplify)。
  const templateName = metadata.runtime?.entry ?? metadata.cfnTemplate;
  const templatePath = metadataPath.replace(/metadata\.json$/, templateName);
  return templateModules[templatePath];
}

// 表示順の安定化のため id で sort。category > id の 2 段 sort は Phase 2 で必要に応じて。
export const PROBLEM_CATALOG: readonly ProblemDetail[] = Object.entries(metadataModules)
  .map(([metadataPath, mod]) =>
    metadataToDetail(mod.default, findTemplateYaml(metadataPath, mod.default)),
  )
  .sort((a, b) => a.id.localeCompare(b.id));

export function findProblem(id: string): ProblemDetail | undefined {
  return PROBLEM_CATALOG.find((p) => p.id === id);
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

/**
 * ADR-023 D4: 今 deploy 可能なのは aws/cloudformation だけ。 予約済み (sakura/azure/gcp) は
 * engine 未実装なので deploy 不可。 catalog / picker はこれで「近日対応」を出し分ける。
 */
export function isExecutableProblemRuntime(runtime: {
  readonly provider: string;
  readonly engine: string;
}): boolean {
  return runtime.provider === "aws" && runtime.engine === "cloudformation";
}
