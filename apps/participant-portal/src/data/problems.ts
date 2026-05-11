/**
 * 競技者向け問題カタログ (#550)。`problems/<category>/<id>/metadata.json` を Vite の
 * `import.meta.glob` で build 時に取り込む。
 *
 * admin-console の `data/problems.ts` と同じ source を読むが、Portal は **競技者目線で
 * 必要な情報だけ** を露出する (= cfnTemplate / cfnParameters は隠す。問題の中身に直結する
 * 設定値は競技者に見せない、答えのヒントになりうるため)。
 *
 * Phase 2 (ADR-003) で問題カタログを DDB-backed API に置き換える予定。それまでは静的
 * build-time discovery で admin-console と Portal を同 source に揃える (= drift 防止)。
 */

export type ProblemCategory = "Battle" | "Challenge";
export type ProblemStatus = "ready" | "draft" | "deprecated";

/**
 * Portal で表示する問題メタ情報。`cfnTemplate` / `cfnParameters` 等の deploy 内部情報は
 * 含めない (= 答えのヒントを意図せず露出させないため)。
 */
export interface ProblemCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly category: ProblemCategory;
  readonly status: ProblemStatus;
  readonly difficulty: 1 | 2 | 3 | 4 | 5;
  readonly estimatedDuration: string;
  readonly shortDescription: string;
  readonly description: string;
  readonly learningGoals: readonly string[];
  readonly tags: readonly string[];
}

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
  learningGoals: string[];
  exposedPorts?: { port: number; name: string }[];
  cfnTemplate?: string;
  cfnParameters?: Record<string, string>;
}

const metadataModules = import.meta.glob<{ default: ProblemMetadata }>(
  "../../../../problems/*/*/metadata.json",
  { eager: true },
);

function metadataToEntry(metadata: ProblemMetadata): ProblemCatalogEntry {
  return {
    id: metadata.id,
    name: metadata.name,
    category: metadata.category,
    status: metadata.status,
    difficulty: metadata.difficulty,
    estimatedDuration: metadata.estimatedDuration,
    shortDescription: metadata.shortDescription,
    description: metadata.description,
    learningGoals: metadata.learningGoals,
    tags: metadata.tags,
  };
}

const PROBLEM_CATALOG: readonly ProblemCatalogEntry[] = Object.values(metadataModules)
  .map((mod) => metadataToEntry(mod.default))
  .sort((a, b) => a.id.localeCompare(b.id));

/** `problemId` (= metadata.json の `id` field) で問題を引く。無ければ undefined。 */
export function findProblemMetadata(problemId: string): ProblemCatalogEntry | undefined {
  return PROBLEM_CATALOG.find((p) => p.id === problemId);
}
