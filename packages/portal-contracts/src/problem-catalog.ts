/**
 * 競技者向け問題カタログの fairness projection (#550 / #2925 / #2926)。
 *
 * `problems/<category>/<id>/metadata.json` を「競技者に見せてよい形」へ narrow する純関数と、
 * その出力型だけを持つ。UI も fetch も glob も無い。
 *
 * **なぜ package に居るのか**: 投影の消費者が 2 つあるから。
 *   - participant-portal は build 時に `import.meta.glob` で metadata.json を取り込み、
 *     bundle にネタバレが残らないよう本 module で narrow する (AWS mode の正本)。
 *   - local-play control plane は bind-mount された `problems/` を実行時に読み、同じ投影を
 *     かけて `/portal/problem-catalog` で返す (Docker local mode の正本 — #2925 / #2926)。
 *
 * 投影を両側に手写しすると fairness contract が 2 か所に増え、片方だけ `description` を
 * 落とし忘れる形の無音ドリフトが起きる。それは本 package が #2203 で潰した失敗そのものなので、
 * 定義はここ 1 か所に置く。
 */

import type {
  ParticipantGraphNode,
  ParticipantGraphRelation,
  ProblemCourseAlignment,
  ProblemCourseMetadataInput,
  ProblemTrackPosition,
} from "./problem-course-projection.js";
import {
  toCourseAlignment,
  toParticipantGraphNodes,
  toParticipantGraphRelations,
  toTrackPosition,
} from "./problem-course-projection.js";

export type ProblemCategory = "Battle" | "Challenge";
export type ProblemStatus = "ready" | "draft" | "deprecated";
/** ADR-008 / Issue #574: 問題実装の公開境界。 public = 本体 repo に payload を持つ教材問題、
 *  private = TenkaCloudChallenges 別 repo に payload を持ち S3 presigned URL で配信される
 *  本格競技問題。 metadata に省略時は public 扱い (= 既存 metadata との互換)。 */
export type ProblemVisibility = "public" | "private";

/**
 * ADR-012 Phase 4 portal predict: 問題 metadata で宣言された phase / disruption の予告 entry。
 * 競技者向けに「いつ何が起きるか」を見せるためだけの shape (= effect の中身 / score 値は隠す)。
 */
export interface ProblemPhaseEntry {
  readonly name: string;
  readonly afterMinutes: number;
  readonly description?: string;
  /** Issue #689 / ADR-013 OQ#7: true のみ portal に流す (= ネタバレ防止)。 */
  readonly publicHint?: boolean;
}

export interface ProblemDisruptionEntry {
  readonly id: string;
  readonly name: string;
  readonly defaultAfterMinutes?: number;
  readonly description?: string;
  /** Issue #689 / ADR-013 OQ#7: true のみ portal に流す (= ネタバレ防止)。 */
  readonly publicHint?: boolean;
}

/**
 * ADR-028 / Issue #1420: portal が表示してよい参加者間 coordination の公開情報。
 * `publicHint === true` の問題だけ catalog に narrow される (= disruptions と同じ fairness 方針)。
 * plugin path は platform 内部 (dispatcher が S3 から load) なので portal には出さない。
 */
export interface ProblemCoordinationEntry {
  readonly name?: string;
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
 * Issue #583 Phase 5: 1 locale 分の override。 各 field 省略時は ja (= top-level の値) に fallback。
 * portal の locale switcher (= "ja" / "en") と対応。
 *
 * fairness contract: `description` (= ネタバレ長文) は portal に embed しないため、
 * locale override も `name` / `shortDescription` / `learningGoals` のみ受け付ける。
 */
export interface ProblemI18nOverride {
  readonly name?: string;
  readonly shortDescription?: string;
  readonly instructions?: string;
  readonly learningGoals?: readonly string[];
}

/**
 * Portal で表示する問題メタ情報。`cfnTemplate` / `cfnParameters` 等の deploy 内部情報は
 * 含めない (= 答えのヒントを意図せず露出させないため)。
 *
 * **fairness contract**:
 * - `description` (= 採点ルール / hardened state / 段階詳細などのネタバレを含む長文) は
 *   admin / authoring view 専用で portal には決して embed しない。 portal では
 *   `shortDescription` のみ。
 * - `phases` / `disruptions` は `publicHint === true` で著者が明示宣言したエントリだけを
 *   portal に流す (= 予告 UI / countdown 用)。 internal の `effect` / `parameters` /
 *   `operatorEditable` 等の採点 trigger 詳細は portal に流さない。
 * - これらは `metadataToEntry` で narrowing する。 build-time 経路では portal bundle そのものに
 *   ネタバレ JSON が残らず (DevTools 越しの inspection でも漏れない)、 runtime 経路では
 *   control plane が投影後の entry だけを wire に載せる (= 落とした field は送信されない)。
 */
export interface ProblemCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly category: ProblemCategory;
  readonly status: ProblemStatus;
  /** ADR-008 Phase 1 / Issue #574: 公開境界。 metadata 省略時は "public" を default に。 */
  readonly visibility: ProblemVisibility;
  readonly difficulty: 1 | 2 | 3 | 4 | 5;
  readonly estimatedDuration: string;
  readonly shortDescription: string;
  readonly instructions?: string;
  readonly learningGoals: readonly string[];
  readonly tags: readonly string[];
  /** ADR-012 Phase 2: endpoint slot 宣言 (= portal plugin の default URL 組立に使う)。 */
  readonly endpoints: readonly ProblemEndpointEntry[];
  /** ADR-012 Phase 4: 段階制の予告 (= afterMinutes で portal が countdown / status pill 表示)。 `publicHint: true` のみ。 */
  readonly phases: readonly ProblemPhaseEntry[];
  /** ADR-012 Phase 4: 「妨害」予告 (= template.yaml-bundled self-triggered Scheduler)。 `publicHint: true` のみ。 */
  readonly disruptions: readonly ProblemDisruptionEntry[];
  /** ADR-012 Phase 5: dashboard.slots[slotName] = portal/<file>.tsx 相対 path の map。 */
  readonly dashboardSlots?: ProblemDashboardSlots;
  /** ADR-028 / Issue #1420: 参加者間 coordination の公開情報 (`publicHint: true` の問題のみ)。 */
  readonly interTeamCoordination?: ProblemCoordinationEntry;
  /** Issue #583 Phase 5: 競技者向け field の locale override (en のみ、 #1108 で es / zh は廃止)。 ja は top-level。 */
  readonly i18n?: {
    readonly en?: ProblemI18nOverride;
  };
  /** ADR-026 / ADR-027: 問題が deploy される cloud (provider) と engine。 未宣言は aws/cloudformation。 */
  readonly runtime: { readonly provider: string; readonly engine: string };
  /** Issue #2786: curriculum 内の位置。 未宣言の問題は track に属さない。 */
  readonly track?: ProblemTrackPosition;
  /** Issue #2786: 外部講座との対応 (participant-safe な部分のみ)。 embargoed は不在になる。 */
  readonly courseAlignment?: ProblemCourseAlignment;
  /** Issue #2786: participant-safe な graph node (learning objective / concept のみ)。 */
  readonly graphNodes: readonly ParticipantGraphNode[];
  /** Issue #2786: participant-safe な relation (teaches / covers / requires のみ)。 */
  readonly graphRelations: readonly ParticipantGraphRelation[];
  /**
   * [TenkaCloudChallenge #402] local play で起動できる問題か。
   *
   * `false` は「この問題は実 AWS (または他クラウド) への deploy が要り、`make local` では
   * 起動できない」。`local/` ディレクトリ (docker-compose.yml と app 実装) を持たない問題が
   * これにあたる。実測された 6 問は `cloudflare-api-security` / `hello-multicloud` /
   * `hello-world` / `http-query` / `wp2shell-friday-night-patch` / `x402-paywall`。
   *
   * **カタログから消さずに印を付ける**のは、#2926 が「学習パスの先が見えること」を理由に
   * AWS 専用問題を意図的にカタログへ含めているため。消すとその決定を黙って覆すことになる。
   * 一方で印が無いと、開けるのに起動できない行き止まりに当たって初めて分かる。
   *
   * `undefined` は「判定していない」。AWS mode の投影は `local/` を見られないのでこうなる。
   * **`undefined` を `false` として扱わないこと** — AWS mode で全問に「ローカル実行不可」の
   * 印が付く。
   */
  readonly localPlayable?: boolean;
}

/**
 * Issue #2786: curriculum / 講座対応 / graph の入力 field は投影 module が所有する
 * (`ProblemCourseMetadataInput`)。 ここで再宣言すると同じ shape が 2 か所に増える。
 *
 * `metadata.json` の生 shape なので `description` 等のネタバレ field を含む。 これを外へ
 * 出してよいのは `metadataToEntry` を通した後だけ。
 */
export interface ProblemMetadata extends ProblemCourseMetadataInput {
  $schema?: string;
  id: string;
  name: string;
  category: ProblemCategory;
  status: ProblemStatus;
  visibility?: ProblemVisibility;
  difficulty: 1 | 2 | 3 | 4 | 5;
  estimatedDuration: string;
  shortDescription: string;
  description: string;
  instructions?: string;
  tags: string[];
  learningGoals: string[];
  exposedPorts?: { port: number; name: string }[];
  cfnTemplate?: string;
  cfnParameters?: Record<string, string>;
  /** ADR-026 / ADR-027: 問題の実行環境 (provider/engine)。 未宣言は aws/cloudformation 既定。 */
  runtime?: { provider?: string; engine?: string; entry?: string };
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
    publicHint?: boolean;
  }[];
  disruptions?: {
    id: string;
    name: string;
    defaultAfterMinutes?: number;
    operatorEditable?: string[];
    parameters?: Record<string, unknown>;
    eventDetailType?: string;
    description?: string;
    publicHint?: boolean;
  }[];
  dashboard?: {
    slots?: Record<string, string>;
  };
  interTeamCoordination?: {
    plugin: string;
    name?: string;
    description?: string;
    publicHint?: boolean;
  };
  /** ADR Issue #583 Phase 5 / #1108: 競技者向け field の locale override。 ja 自体は top-level が正本。 サポート対象は en のみ。 */
  i18n?: {
    en?: ProblemI18nOverride;
  };
}

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

/**
 * i18n override から portal 用 field のみ取り出す (= description は drop)。 全 locale entry が
 * 空 (= override field が無い) なら undefined を返し、 catalog entry の i18n field 自体を省略する。
 */
function sanitizeI18n(raw: ProblemMetadata["i18n"]): ProblemCatalogEntry["i18n"] | undefined {
  if (!raw) return undefined;
  const en = raw.en
    ? omitUndefined({
        name: raw.en.name,
        shortDescription: raw.en.shortDescription,
        instructions: raw.en.instructions,
        learningGoals: raw.en.learningGoals,
      })
    : undefined;
  if (!en || Object.keys(en).length === 0) return undefined;
  return { en: en as ProblemI18nOverride };
}

/**
 * `metadata.json` 1 件を競技者向け catalog entry へ narrow する。 上の fairness contract
 * (`description` drop / `publicHint` filter) の実装本体。
 *
 * build-time (portal の glob) と runtime (local-play control plane) の両経路が同じ関数を通る。
 */
export function metadataToEntry(metadata: ProblemMetadata): ProblemCatalogEntry {
  const dashboardSlots = metadata.dashboard?.slots;
  const publicI18n = sanitizeI18n(metadata.i18n);
  const graphNodes = toParticipantGraphNodes(metadata);
  return {
    id: metadata.id,
    name: metadata.name,
    category: metadata.category,
    status: metadata.status,
    // metadata 省略時は public 扱い (= 既存問題互換 + ADR-008 D4 の "省略時 public" 規約)。
    visibility: metadata.visibility ?? "public",
    difficulty: metadata.difficulty,
    estimatedDuration: metadata.estimatedDuration,
    shortDescription: metadata.shortDescription,
    instructions: metadata.instructions,
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
      metadata.phases
        ?.filter((p) => p.publicHint === true)
        .map(
          (p) =>
            omitUndefined({
              name: p.name,
              afterMinutes: p.afterMinutes,
              description: p.description,
              publicHint: true,
            }) as ProblemPhaseEntry,
        ) ?? [],
    disruptions:
      metadata.disruptions
        ?.filter((d) => d.publicHint === true)
        .map(
          (d) =>
            omitUndefined({
              id: d.id,
              name: d.name,
              defaultAfterMinutes: d.defaultAfterMinutes,
              description: d.description,
              publicHint: true,
            }) as ProblemDisruptionEntry,
        ) ?? [],
    ...(dashboardSlots && Object.keys(dashboardSlots).length > 0
      ? { dashboardSlots: dashboardSlots as ProblemDashboardSlots }
      : {}),
    // ADR-028 / #1420: publicHint===true の coordination だけ portal に narrow (= disruptions と同方針)。
    ...(metadata.interTeamCoordination?.publicHint === true
      ? {
          interTeamCoordination: omitUndefined({
            name: metadata.interTeamCoordination.name,
            description: metadata.interTeamCoordination.description,
          }) as ProblemCoordinationEntry,
        }
      : {}),
    ...(publicI18n ? { i18n: publicI18n } : {}),
    // ADR-026 / ADR-027: 実行環境を露出。 未宣言の legacy 問題は aws/cloudformation 既定。
    runtime: {
      provider: metadata.runtime?.provider ?? "aws",
      engine: metadata.runtime?.engine ?? "cloudformation",
    },
    // Issue #2786: curriculum 位置と講座対応。 どちらも宣言が無ければ field ごと省略する
    // (= track 未設定の既存問題の entry shape を変えない)。
    ...omitUndefined({
      track: toTrackPosition(metadata.track),
      courseAlignment: toCourseAlignment(metadata.courseAlignment),
    }),
    graphNodes,
    graphRelations: toParticipantGraphRelations(
      metadata.relations,
      new Set(graphNodes.map((n) => n.id)),
    ),
  };
}
