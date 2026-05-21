/**
 * 問題カタログ。`problems/` ディレクトリの metadata.json を Vite の `import.meta.glob`
 * で build 時に取り込む。問題を追加するときは `problems/<category>/<id>/{template.yaml,
 * metadata.json}` を置くだけで、本ファイルへの手作業は不要。
 *
 * Phase 2 (ADR-003) で問題カタログを DDB-backed の API に置き換える予定。それまでは
 * 静的 build-time discovery で 1 元化を保つ。
 */

export type ProblemCategory = "Battle" | "Challenge";
export type ProblemStatus = "ready" | "draft" | "deprecated";

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
interface ProblemMetadata {
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

function metadataToDetail(metadata: ProblemMetadata): ProblemDetail {
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
    ...(metadata.defaultRegion ? { defaultRegion: metadata.defaultRegion } : {}),
    ...(metadata.supportedRegions && metadata.supportedRegions.length > 0
      ? { supportedRegions: metadata.supportedRegions }
      : {}),
  };
}

// 表示順の安定化のため id で sort。category > id の 2 段 sort は Phase 2 で必要に応じて。
export const PROBLEM_CATALOG: readonly ProblemDetail[] = Object.values(metadataModules)
  .map((mod) => metadataToDetail(mod.default))
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
    ...(p.defaultRegion ? { defaultRegion: p.defaultRegion } : {}),
    ...(p.supportedRegions ? { supportedRegions: p.supportedRegions } : {}),
  }));
}
