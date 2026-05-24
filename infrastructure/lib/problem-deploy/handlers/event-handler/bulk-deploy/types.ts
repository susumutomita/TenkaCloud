import type { PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";
import type { DeploymentItem } from "../../deploy-handler/types.js";
import type { EventItem, EventProblemTarget, TeamItem } from "../types.js";

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
}

export type BulkDeployOutcome = { kind: "ok"; result: BulkDeployResult } | { kind: "not_found" };

/** DDB TransactWrite 1 transaction = 25 items の上限。 retry/forceRedeploy 時は 2 ops/entry。 */
export const TRANSACT_WRITE_BATCH = 25;
/** EventBridge PutEvents 1 call = 10 entries の上限。 */
export const PUT_EVENTS_BATCH = 10;

/** 既定 TTL 7 日 (= deployments の DDB TTL attribute へ秒単位で書き込む)。 */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const toEpochSeconds = (ms: number): number => Math.floor(ms / 1000);

export interface PlanEntry {
  readonly item: DeploymentItem;
  readonly entry: PutEventsRequestEntry;
  /** retry / force redeploy のとき、対応する旧行の jobId (= これを DELETE)。 */
  readonly replacesJobId?: string;
}

export interface LoadedBulkDeployTargets {
  readonly event: Partial<EventItem>;
  readonly allTeams: readonly TeamItem[];
  readonly allProblems: readonly EventProblemTarget[];
}

export interface SelectedBulkDeployTargets {
  readonly teams: readonly TeamItem[];
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
}

export interface PublishFailure {
  readonly jobId: string;
  readonly reason: string;
}
