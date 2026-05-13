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
 * ADR-012 Phase 5: 1 problem に紐づく portal plugin slot map。 `dashboard.slots[slotName]`
 * の各 entry は metadata.json で `portal/<SlotName>.tsx` 形式の相対 path を持つ。 portal
 * の plugin loader (= src/plugins/loader.ts) がこれを glob で照合して該当 chunk を lazy load する。
 */
export type ProblemDashboardSlots = Readonly<Record<string, string>>;

/**
 * ADR-012 Phase 2: endpoint slot 宣言 (= portal が plugin に渡す default URL の組立に使う)。
 * `default.from` は現状 `cfn-output` のみ。 `appendPath` で 1 CFn output を複数 slot で path
 * 違いに使い回せる (= microservice-migration の BaseUrl + /users /orders /catalog 等)。
 */
export interface ProblemEndpointEntry {
  readonly slot: string;
  readonly default: {
    readonly from: "cfn-output";
    readonly key: string;
    readonly appendPath?: string;
  };
  readonly overridable: boolean;
  readonly label?: string;
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
  /** ADR-012 Phase 2: endpoint slot 宣言 (= portal plugin の default URL 組立に使う)。 */
  readonly endpoints: readonly ProblemEndpointEntry[];
  /** ADR-012 Phase 4: 段階制の予告 (= afterMinutes で portal が countdown / status pill 表示)。 */
  readonly phases: readonly ProblemPhaseEntry[];
  /** ADR-012 Phase 4: 「妨害」予告 (= template.yaml-bundled self-triggered Scheduler)。 */
  readonly disruptions: readonly ProblemDisruptionEntry[];
  /** ADR-012 Phase 5: dashboard.slots[slotName] = portal/<file>.tsx 相対 path の map。 */
  readonly dashboardSlots?: ProblemDashboardSlots;
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
  endpoints?: {
    slot: string;
    default: { from: "cfn-output"; key: string; appendPath?: string };
    overridable?: boolean;
    label?: string;
    description?: string;
  }[];
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
  dashboard?: {
    slots?: Record<string, string>;
  };
}

const metadataModules = import.meta.glob<{ default: ProblemMetadata }>(
  "../../../../problems/*/*/metadata.json",
  { eager: true },
);

/**
 * `exactOptionalPropertyTypes` 下で `{ ...(x ? {x} : {}) }` の連鎖を避けるための一括 helper。
 * undefined / 空文字 の値を持つ key を落として、 残った key だけの shape を返す。
 */
function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function metadataToEntry(metadata: ProblemMetadata): ProblemCatalogEntry {
  const dashboardSlots = metadata.dashboard?.slots;
  // 競技者向けには operator 内部 field (= effect / parameters / operatorEditable /
  // eventDetailType 等の採点 / trigger internals) を全部隠す。 1 箇所に narrowing を集約
  // して props-builder 等での re-implement を防ぐ。
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
    endpoints:
      metadata.endpoints?.map((ep) => ({
        slot: ep.slot,
        default: omitUndefined({
          from: ep.default.from,
          key: ep.default.key,
          appendPath: ep.default.appendPath,
        }) as ProblemEndpointEntry["default"],
        overridable: ep.overridable === true,
        ...omitUndefined({ label: ep.label, description: ep.description }),
      })) ?? [],
    phases:
      metadata.phases?.map(
        (p) =>
          omitUndefined({
            name: p.name,
            afterMinutes: p.afterMinutes,
            description: p.description,
          }) as ProblemPhaseEntry,
      ) ?? [],
    disruptions:
      metadata.disruptions?.map(
        (d) =>
          omitUndefined({
            id: d.id,
            name: d.name,
            defaultAfterMinutes: d.defaultAfterMinutes,
            description: d.description,
          }) as ProblemDisruptionEntry,
      ) ?? [],
    ...(dashboardSlots && Object.keys(dashboardSlots).length > 0
      ? { dashboardSlots: dashboardSlots as ProblemDashboardSlots }
      : {}),
  };
}

const PROBLEM_CATALOG: readonly ProblemCatalogEntry[] = Object.values(metadataModules)
  .map((mod) => metadataToEntry(mod.default))
  .sort((a, b) => a.id.localeCompare(b.id));

// O(1) lookup map (= per-render hot path で findProblemMetadata を複数回呼ぶ場合の linear scan 抑止)。
const PROBLEM_CATALOG_BY_ID: ReadonlyMap<string, ProblemCatalogEntry> = new Map(
  PROBLEM_CATALOG.map((p) => [p.id, p]),
);

/** `problemId` (= metadata.json の `id` field) で問題を引く。無ければ undefined。 */
export function findProblemMetadata(problemId: string): ProblemCatalogEntry | undefined {
  return PROBLEM_CATALOG_BY_ID.get(problemId);
}
