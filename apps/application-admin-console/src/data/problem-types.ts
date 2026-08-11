import type { CostRiskLevel } from "@tenkacloud/problem-cost";

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

export interface ProblemSingleRuntimeSummary {
  readonly provider: string;
  readonly engine: string;
}

export interface ProblemCompositeRuntimeTargetSummary extends ProblemSingleRuntimeSummary {
  readonly id: string;
}

export type ProblemRuntimeSummary =
  | ProblemSingleRuntimeSummary
  | {
      readonly kind: "composite";
      readonly targets: readonly ProblemCompositeRuntimeTargetSummary[];
    };

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
   * Issue #1201: 動作確認済の region 集合。宣言された場合、EventCreate
   * wizard の region picker はこの集合だけを選択肢として出す (= 動かない region への
   * misconfig 予防)。 `defaultRegion` はこの集合に含まれていることを validator が保証。
   * 未宣言なら全 AWS region から選べる (= 後方互換)。
   */
  supportedRegions?: readonly string[];
  /** 問題の deploy 先 provider と engine。未宣言は aws/cloudformation。 */
  runtime: ProblemRuntimeSummary;
  /**
   * Issue #1776: `metadata.json` の `scoring.kind` (5 種類の builtin kind:
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
  /** 問題の実行環境。未宣言は aws/cloudformation。 */
  runtime?:
    | { provider?: string; engine?: string; entry?: string }
    | {
        kind: "composite";
        targets: {
          id: string;
          provider: string;
          engine: string;
          entry: string;
        }[];
      };
  /**
   * `metadata.json` の scoring 宣言。UI が使うのは `kind` のみ (kind は schema 上 scoring 内で必須)。
   * 配点詳細 (points / flagOutputKey 等) は backend の責務なので型として持たない。
   */
  scoring?: { kind: string };
  /** Issue #1201: 問題作成者宣言の推奨 region。 wizard が初期値に使う。 */
  defaultRegion?: string;
  /** Issue #1201 Phase 2: 動作確認済 region 集合。 wizard が picker の選択肢を絞る。 */
  supportedRegions?: string[];
}
