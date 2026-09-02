import type { PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";
import type { TeamDeploymentRecord } from "../../../control-data/teams-repository.js";
import type { DeploymentItem } from "../../deploy-handler/types.js";
import type { ProblemRuntime } from "../../shared/runtime/index.js";
import type { EventItem, EventProblemTarget } from "../types.js";

/**
 * `POST /events/{eventId}/deploy` のレスポンス。N×M (teams × problems) の deployment
 * 行を作成し、既存の DeployCreateRequested 経路に fan-out した結果を返す。
 */
export interface BulkDeployResult {
  readonly eventId: string;
  readonly enqueued: number;
  /** 既存 deployment 行と問題 ID 衝突で skip された組み合わせ数 (再 deploy 防止)。 */
  readonly skipped: number;
  /**
   * Phase 2.2 (Issue #459): verified=false / 未登録の awsAccountId のため reject された
   * team 数。`unverifiedAccounts` には実 awsAccountId を入れて operator が補正できるよう
   * 通知する。
   */
  readonly unverified?: number;
  /** Phase 2.2: 上記の補足情報。重複は除く (Set 化)。 */
  readonly unverifiedAccounts?: readonly string[];
  /**
   * [#2563 v1] 非 AWS single-provider runtime のため bulk 経路 (frozen CFn pipeline)
   * では実行できず reject した問題数。single-deploy (adapter dispatch) 経路で
   * team ごとに deploy する。bulk adapter dispatch 対応までの明示的な拒否。
   */
  readonly unsupportedRuntime?: number;
  /** [#2563 v1] 上記の問題 id 一覧 (sorted、重複除去済み)。 */
  readonly unsupportedRuntimeProblems?: readonly string[];
  /**
   * [#2571] 非 AWS single-provider (gcp/azure/sakura) の team に、その provider の
   * credential が未登録だったため plan から除外された組数。`unverified` (AWS 版) の
   * 非 AWS 対応物 — bulk 経路自体は adapter dispatch で実行できるが、この team に
   * 限っては credential 登録が先に必要。
   */
  readonly missingCredential?: number;
  /** [#2571] 上記の `${provider}:${teamSlug}` 一覧 (sorted、重複除去済み)。 */
  readonly missingCredentials?: readonly string[];
}

export type BulkDeployOutcome =
  | { kind: "ok"; result: BulkDeployResult }
  | { kind: "not_found" }
  /**
   * [Issue #3169] At least one coordination problem cannot hold this event's
   * team count on the selected backend, so nothing was deployed.
   *
   * Distinct from a failed deploy because nothing was attempted: no rows were
   * written and no work was published, so there is nothing to retry until the
   * event or the backend changes. `refusals` carries one operator-readable
   * sentence per problem, naming both numbers and the team count that fits.
   */
  | { kind: "capacity_exceeded"; refusals: readonly string[] };

/**
 * DDB TransactWriteItems の上限は 1 transaction = 100 actions (2022 以前は 25)。 ここでは
 * 保守的に 25 で chunk する (= 上限の引き上げに伴う batch size 拡大は別途 capacity 判断)。
 * retry/forceRedeploy 時は 1 entry = Put + Delete の 2 ops なので、 entry 数はこの半分が上限。
 */
export const TRANSACT_WRITE_BATCH = 25;

/** 既定 TTL 7 日 (= deployments の DDB TTL attribute へ秒単位で書き込む)。 */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const toEpochSeconds = (ms: number): number => Math.floor(ms / 1000);

/**
 * [#2571 review-fix] `${provider}#${teamSlug}` cache-key builder shared by
 * `verified-accounts.ts`'s `resolveBulkNonAwsCredentials` (the Set builder) and
 * `plan-builder.ts`'s `buildNonAwsPlanCandidate` (the `.has()` lookup) — a single
 * definition means the delimiter cannot drift between producer and consumer.
 * (The `${provider}:${teamSlug}` format used in the *reporting* shape —
 * `BulkDeployResult.missingCredentials` — is a separate, unrelated convention;
 * it stays exactly as-is, it is an API contract.)
 */
export function nonAwsCredentialKey(provider: string, teamSlug: string): string {
  return `${provider}#${teamSlug}`;
}

/**
 * [#2571] Bulk plan entry。 dispatch channel で discriminate する:
 *   - `"eventbridge"`: AWS/CFn 行。 frozen `DeployCreateRequested` -> CFn state machine
 *     pipeline に乗る (= #2571 以前と byte-identical、`kind` discriminant を足しただけ)。
 *   - `"adapter"`: 非 AWS single-provider 行 (gcp/azure/sakura)。 `dispatchBulkAdapterEntries`
 *     (`selectAdapter` + `dispatchPreparedDeployment`、single-deploy と同じ adapter seam)
 *     で直接 dispatch する — CFn pipeline は非 AWS deploy を表現できないため決して乗らない。
 * 両方とも `item` (= 永続化する DeploymentItem) + optional `replacesJobId` (retry /
 * forceRedeploy の置換対象) を持つ — `persistence.ts` はこの共通 2 field だけを読む。
 */
export type PlanEntry =
  | {
      readonly kind: "eventbridge";
      readonly item: DeploymentItem;
      readonly entry: PutEventsRequestEntry;
      /** retry / force redeploy のとき、対応する旧行の jobId (= これを DELETE)。 */
      readonly replacesJobId?: string;
    }
  | {
      readonly kind: "adapter";
      readonly item: DeploymentItem;
      readonly runtime: ProblemRuntime;
      readonly problemDir: string;
      readonly teamSlug: string;
      /** retry / force redeploy のとき、対応する旧行の jobId (= これを DELETE)。 */
      readonly replacesJobId?: string;
    };

/**
 * [#2571 review-fix] Narrowed `PlanEntry` aliases, hoisted here so
 * `orchestrator.ts` can partition `plan.entries` exactly once and hand each
 * channel (`publishBulkDeployPlan` / `dispatchBulkAdapterEntries`) its own
 * pre-filtered array — previously `publish.ts` and `adapter-dispatch.ts` each
 * declared (and re-derived, in `publish.ts`'s case by filtering again inside)
 * an unexported local copy of the same two types.
 */
export type EventBridgePlanEntry = Extract<PlanEntry, { kind: "eventbridge" }>;
export type AdapterPlanEntry = Extract<PlanEntry, { kind: "adapter" }>;

export interface LoadedBulkDeployTargets {
  readonly event: Partial<EventItem>;
  // Teams aggregate は repository seam 経由で読むため、 物理 DDB キーを
  // 剥がした deployment view。下流は team metadata と、backend が明示した plaintext/hash
  // credential の discriminated union だけを読む。
  readonly allTeams: readonly TeamDeploymentRecord[];
  readonly allProblems: readonly EventProblemTarget[];
}

export interface SelectedBulkDeployTargets {
  readonly teams: readonly TeamDeploymentRecord[];
  readonly problems: readonly EventProblemTarget[];
}

export interface ExistingDeploymentIndex {
  readonly failedByKey: Map<string, { jobId: string }>;
  readonly forceRedeployByKey: Map<string, { jobId: string }>;
  readonly existingKey: Set<string>;
}

export interface BulkDeployPlan {
  readonly entries: readonly PlanEntry[];
  readonly createdAt: string;
  readonly skipped: number;
  readonly unverifiedAccounts: Set<string>;
  /** [#2563 v1] bulk では実行できない非 AWS single-provider の問題 id 集合。 */
  readonly unsupportedRuntimeProblems: Set<string>;
  /** [#2571] credential 未登録で除外された `${provider}:${teamSlug}` 集合。 */
  readonly missingCredentials: Set<string>;
}

export interface PublishFailure {
  readonly jobId: string;
  readonly reason: string;
}
