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
 * ADR-012 Phase 4 portal predict: 問題 metadata で宣言された phase / disruption の予告 entry。
 * 競技者向けに「いつ何が起きるか」を見せるためだけの shape (= effect の中身 / score 値は隠す)。
 */
export interface ProblemPhaseEntry {
  readonly name: string;
  readonly afterMinutes: number;
  readonly description?: string;
}

export interface ProblemDisruptionEntry {
  readonly id: string;
  readonly name: string;
  readonly defaultAfterMinutes?: number;
  readonly description?: string;
}

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
  /** ADR-012 Phase 4: 段階制の予告 (= afterMinutes で portal が countdown / status pill 表示)。 */
  readonly phases: readonly ProblemPhaseEntry[];
  /** ADR-012 Phase 4: 「妨害」予告 (= template.yaml-bundled self-triggered Scheduler)。 */
  readonly disruptions: readonly ProblemDisruptionEntry[];
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
  phases?: {
    name: string;
    afterMinutes: number;
    effect?: Record<string, unknown>;
    description?: string;
  }[];
  disruptions?: {
    id: string;
    name: string;
    defaultAfterMinutes?: number;
    operatorEditable?: string[];
    parameters?: Record<string, unknown>;
    eventDetailType?: string;
    description?: string;
  }[];
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
    // 競技者向けには effect の中身 (= switchPlatformToDegraded / scorePathOverride 等の
    // 採点 internals) は隠して、 name / afterMinutes / description だけ露出する。
    phases:
      metadata.phases?.map((p) => ({
        name: p.name,
        afterMinutes: p.afterMinutes,
        ...(p.description ? { description: p.description } : {}),
      })) ?? [],
    // 同じく eventDetailType / parameters / operatorEditable 等の operator 向け internals は隠す。
    disruptions:
      metadata.disruptions?.map((d) => ({
        id: d.id,
        name: d.name,
        ...(typeof d.defaultAfterMinutes === "number"
          ? { defaultAfterMinutes: d.defaultAfterMinutes }
          : {}),
        ...(d.description ? { description: d.description } : {}),
      })) ?? [],
  };
}

const PROBLEM_CATALOG: readonly ProblemCatalogEntry[] = Object.values(metadataModules)
  .map((mod) => metadataToEntry(mod.default))
  .sort((a, b) => a.id.localeCompare(b.id));

/** `problemId` (= metadata.json の `id` field) で問題を引く。無ければ undefined。 */
export function findProblemMetadata(problemId: string): ProblemCatalogEntry | undefined {
  return PROBLEM_CATALOG.find((p) => p.id === problemId);
}
