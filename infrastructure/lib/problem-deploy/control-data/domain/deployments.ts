/**
 * [Issue #2527 Slice 1] Deployments aggregate — domain records, mutation outcomes, and the (Slice 2 target) repository port.
 *
 * Extracted verbatim from the former all-aggregate `control-data/types.ts` so each
 * aggregate's domain contract lives in its own module. `../types.ts` re-exports this
 * module as a temporary compatibility barrel while consumers migrate to direct imports.
 */

import type {
  CompositeInputBinding,
  CompositeOutputDeclaration,
} from "@tenkacloud/problem-runtime";

/**
 * [Issue #2527 Slice 1 step 2] Deployment lifecycle status — the domain union is
 * the source of truth; the request-validation Zod enum in
 * `handlers/deploy-handler/types.ts` (`DeploymentStatusSchema`, which carries the
 * per-status operational docs) is compile-time locked to this union.
 */
export type DeploymentStatus =
  | "PENDING"
  | "APPROVAL_PENDING"
  | "IN_PROGRESS"
  | "COMPLETE"
  | "FAILED"
  | "DELETING"
  | "DELETED"
  | "EXPIRED"
  | "AUTO_DELETED";

/**
 * Issue #742 Phase 2: progressive hint reveal 1 件の記録。 Deployments table の
 * `hintsRevealed` attribute に append する。
 *
 *   - hintId: metadata.scoring.hints[].id を参照 (= ProgressiveHint.id と一致)
 *   - revealedAt: ISO 8601 string (= 監査 log + UI 表示用)
 *   - penaltyApplied: 実 deduction された penalty (= metadata 編集後にも記録が drift しないため
 *     当時値を保存。 metadata.scoring.hints[].penalty 変更時にも score 再計算は走らない)
 */
export interface HintRevealRecord {
  readonly hintId: string;
  readonly revealedAt: string;
  readonly penaltyApplied: number;
}

/**
 * [Problem Packs / Issue #2096] Deployment + audit pack provenance — the resolved
 * source identity persisted for PACK-SOURCED deployments. The shape is closed to
 * id / version / digest / snapshot id only: a pack's mutable source (`sourceRef`,
 * `snapshotPath`, local directory, git credentials) never reaches this shape, so
 * it can never appear in an API response, the DDB row, or an audit record. The
 * projection logic lives in `handlers/shared/deployment-provenance.ts`.
 */
export interface DeploymentProvenance {
  /** Reverse-DNS pack id from the immutable pinned snapshot. */
  readonly packId: string;
  /** Exact SemVer of the pack from the immutable pinned snapshot. */
  readonly packVersion: string;
  /** Hex content digest of the pinned pack snapshot. */
  readonly contentDigest: string;
  /** Deterministic id of the event's pinned catalog snapshot. */
  readonly catalogSnapshotId: string;
}

// ---------------------------------------------------------------------------
// Deployments aggregate — READ seam.
//
// The Deployments table carries three GSIs and is (per the #2441 inventory) the
// single largest standing DynamoDB cost. This seam extracts the READ access the
// six handler groups perform so another backend can stand in behind the same domain methods.
// The DynamoDB backend keeps every
// KeyCondition / Filter / Projection / placeholder / Limit / ScanIndexForward
// byte-identical to the pre-seam handler code.
// ---------------------------------------------------------------------------

/**
 * [Issue #2441 / Phase B1] The domain shape of one deployment META row.
 *
 * [Issue #2527 Slice 1 step 2] This record is the source of truth: the physical
 * DynamoDB row (`handlers/deploy-handler/types.ts`'s `DeploymentItem`) derives
 * from it by adding the base PK/SK plus GSI1/GSI2 keys, so a new deployment
 * attribute is added HERE and flows to the handler layer — never the reverse.
 * Physical keys are an implementation detail of the DynamoDB backend; the SQLite
 * backend derives its own keys / columns.
 *
 * `teamLoginKey` stays on the record (verbatim relocation, B1). The SHA-256
 * hashing of the participant bearer for the SQL index is a backend concern,
 * exactly as the Teams seam handled it (#2290).
 */
export type DeploymentRecord = {
  jobId: string;
  problemId: string;
  tenantId: string;
  awsAccountId: string;
  /**
   * Cross-account deploy RoleArn resolved from CompetitorAccounts. Participant SSO uses it as
   * the first hop before assuming the per-problem ParticipantViewerRole.
   */
  competitorRoleArn?: string;
  /** SSM SecureString path that stores the tenant ExternalId for cross-account operations. */
  externalIdParameterName?: string;
  region: string;
  /**
   * 内部 slug。operator が deploy form で入力し、`namePrefix` (CFn StackName) の
   * 由来となる。CFn StackName は immutable なので、この値も deploy 後に変えない。
   * 競技者向け表示には `displayTeamName` を優先するため、portal UI には基本出さない。
   */
  teamName: string;
  namePrefix: string;
  /**
   * 競技者が portal `PATCH /portal/me` で設定する表示用チーム名。チームビルディング
   * 体験のため、operator 入力ではなく競技者自身が決める。未設定なら undefined。
   */
  displayTeamName?: string;
  /**
   * One-time participant bearer. Present on DynamoDB-backed records and while a
   * caller already holds plaintext; SQL records deliberately omit it.
   */
  teamLoginKey?: string;
  /**
   * Internal SQL write handoff. It is never serialized into a payload or API
   * response; the SQL adapter moves it into the indexed login_key_hash column.
   */
  teamLoginKeyHash?: string;
  status: DeploymentStatus;

  /**
   * [#1410-1412] 非 AWS runtime の問題 (sakura/azure/gcp) を deploy したときの
   * provider / engine / entry。 teardown / status が CFn 経由か adapter 経由かの判別に使う。
   * **absent = aws/cloudformation** (legacy 行 / 既定。 = 従来どおり CFn 経路)。
   */
  runtimeProvider?: string;
  runtimeEngine?: string;
  runtimeEntry?: string;

  /** worker (CFn 起動側) が埋める */
  stackId?: string;
  /** Step Functions の CodeBuildStartBuild output (= `Build.Id`) から永続化する build ID。 */
  buildId?: string;
  /** StatusUpdater が CFn Outputs を JSON 文字列で書き戻す */
  stackOutputs?: string;
  failureReason?: string;

  createdAt: string;
  updatedAt: string;
  /**
   * [Issue #2946] このデプロイが **一度でも `COMPLETE` に到達した** ことの恒久 marker。
   *
   * 現在値の `status` からは復元できない。成功した deploy は撤去で `DELETING` → `DELETED`
   * (あるいは `EXPIRED` / `AUTO_DELETED`) に遷移するが、`bulk-delete.ts` の
   * `prepareBulkTeardownEntry` は `DELETING` / `DELETED` だけを skip するので **`FAILED` も
   * teardown 経路で `DELETED` になりうる**。つまり `DELETED` は「成功後の撤去」と「失敗後の
   * 撤去」の両方を含み、status だけでは「健全に回しているテナント」と「一度も成功していない
   * テナント」を区別できない。
   *
   * 最初に `COMPLETE` へ遷移したときだけ書き、以後は上書きしない。teardown 系の遷移でも
   * 消さない。**既存行には存在しないので遡及はできない** — 集計側は「不明」と「0 件」を
   * 混同してはならない。
   */
  completedAt?: string;
  /**
   * [Issue #3128] このデプロイの **撤去が要求された** ことの恒久 marker (`completedAt` と同型)。
   *
   * `status` からは復元できない。teardown は行を `DELETING` にするが、その後 delete state
   * machine が `DELETE_FAILED` / task failure を観測すると `markFailed` で `FAILED` へ移り、
   * `FAILED` は **deploy 失敗と見分けがつかない**。結果として「撤去済みだが FAILED の行」が
   * `DELETED_LIKE_STATUSES` を通り抜け、event teardown が消した coordination namespace へ
   * 参加者の op が届き、`plugin.initialState` から試合が作り直されていた。
   *
   * 最初に `DELETING` へ遷移したときだけ書き、以後は上書きしない。**既存行には存在しない**
   * ので遡及はできない (= 不在は「撤去要求なし」ではなく「不明」)。
   */
  teardownRequestedAt?: string;
  /** TTL 属性 (epoch seconds)。auto-teardown のキー。 */
  expiresAt: number;

  /** Reserved for bulk deploy. */
  accountGroupId?: string;
  problemSetId?: string;

  /**
   * bulk deploy 経由で作られた deployment 行は、紐づく Event / Team を
   * 参照する。旧 `POST /problems/:id/deploy` 経路で作られた行は両方 undefined (後方互換)。
   */
  eventId?: string;
  teamId?: string;

  /**
   * [Problem Packs / Issue #2096] Pack provenance for a PACK-SOURCED deployment,
   * copied from the EVENT-pinned catalog snapshot (#2095) at deploy time — never
   * from client input. Absent for core (non-pack) deployments, so legacy / core
   * rows stay byte-identical. The detail API surfaces it only when present; the
   * list summary never does. It carries no local path / source credential.
   */
  provenance?: DeploymentProvenance;

  /**
   * 競技開始時刻 (ISO8601) を Event から denormalize したコピー。HealthCheckLambda が
   * probe / 採点 gate で参照する (now < eventStartsAt なら skip)。Bulk Deploy 時に
   * Event.startsAt をコピーし、operator が schedule API で更新したら全 deployment 行へ
   * 伝播する (event-handler/schedule.ts)。未設定 → 採点無し (= deploy 直後の誤加算防止)。
   */
  eventStartsAt?: string;
  /**
   * 競技終了時刻 (ISO8601) を Event から denormalize したコピー。HealthCheckLambda が
   * probe / 採点 gate で参照する (eventEndsAt <= now なら skip)。`POST /events/:id/end`
   * で operator が明示的に終了させたとき、event-handler が全 deployment 行へ伝播する。
   * 未設定 → 終了 gate 無し (= 旧 deployment / 終了未指示の event で既存挙動を保つ)。
   */
  eventEndsAt?: string;

  /** Scoring engine が加算したチームの累計ポイント。0 default。 */
  score?: number;
  /** Last durable coordination transition delivered to this deployment. */
  coordinationScoreRunId?: string;
  coordinationScoreVersion?: number;
  /** Coordination contribution to score; ordinary scoring owns the remainder. */
  coordinationSubtotal?: number;
  /** 最後に scoring が走った時刻 (ISO 8601)。 */
  lastScoredAt?: string;
  /** Battle (uptime) で最後の health check が成功したか。 */
  lastResult?: "ok" | "fail";
  /** 最新の scoring probe が観測した participant-facing posture snapshot。 */
  posture?: string;
  /** 最新の scoring probe が分類した platform tier (例: posture-3 / production)。 */
  platform?: string;
  /**
   * Challenge (flag) で 1 度でも正解 submit されたら true。再提出での重複加算を防ぐ。
   */
  flagSubmitted?: boolean;
  /**
   * Issue #2283: この行が Progression Gate の Gate challenge で、 完了 bonus
   * (teamOverrides[].completionBonus) を加算済みなら加算時刻 (ISO 8601)。
   * `attribute_not_exists` ConditionExpression の冪等 guard として使い、 bonus の
   * 二重加算をレースから守る (= flagSubmitted と同じ one-time パターン)。
   */
  gateBonusAwardedAt?: string;
  /**
   * Issue #2283: Gate 完了を scoring tick が latch した時刻 (ISO 8601)。 完了後に uptime
   * penalty で score が 0 以下へ戻っても unlock 状態を維持するための one-time marker
   * (bonus の有無と独立に全 team の Gate 行へ書かれる)。
   */
  gateCompletedAt?: string;
  /**
   * Issue #1796: multi-flag kind で正解済みの sub-flag id の集合。 DynamoDB の String Set (SS)
   * として保持し、 lib-dynamodb が JS `Set<string>` ↔ SS を marshal する。 旧 row / 手書き行は
   * 持たない (= 「未解答」 と等価) ので、 単一 `flagSubmitted` boolean を集合へ拡張した形。
   * flag ごとに 1 回だけ ADD し、 `ConditionExpression` で 2 重加算を防ぐ。
   */
  solvedFlagIds?: ReadonlySet<string>;
  /**
   * Issue #817: Challenge (flag) で不正解 submit を受けた累計回数。 0 default。
   * `wrongAnswerPenalty > 0` の問題で 1 不正解ごとに ADD 1 + score 減算する経路で使う。
   */
  wrongAnswerCount?: number;
  /**
   * 直近の health check で endpoint ごとに probe した結果の JSON 文字列。
   * shape: `{ [outputKey]: { ok, checkedAt, since? } }`。
   * `since` は ok=false が続いている開始時刻 (= attack を検知した時刻)。
   * Battle 防御側が「どの endpoint が何分前から落ちている」を画面で見るため。
   */
  endpointsHealth?: string;
  /**
   * [Issue #2422] uptime-multi の直近サイクル attack-probe 結果の JSON 文字列。
   * shape: `{ checkedAt?, probes: [{ label?, symptom?, outcome, penalty }] }`。
   * 「green (200) なのに満点でない理由」 (= まだ刺さっている probe) を participant portal に
   * 見せる。 非スポイラー不変条件により slot / path (= 正確な endpoint)・脆弱性クラスは含めない。
   * attackProbes を持つ問題でのみ書かれ、 旧行 / 他 kind は本属性を持たない (= 後方互換)。
   */
  attackProbes?: string;
  /**
   * 5 種 builtin kind の中で polling 越しに per-deployment で保持する
   * scoring state の JSON 文字列。
   * - `attack-detection` の前回 counter (= 差分加算の baseline)
   * - `phased-polling` の bonus once 制御 flag map
   * shape: `{ attackCount?: number, bonusAwarded?: Record<string, true> }`。
   * dispatcher が UpdateItem で書き戻し、 次 tick で read-through に復元する。
   */
  scoringState?: string;
  /**
   * Issue #742 Phase 2: 競技者が reveal した progressive hint の記録。 reveal は idempotent
   * (= 同 hintId 重複は no-op、 penalty は 1 度だけ適用)。
   *
   * shape: `[{ hintId, revealedAt: ISO8601, penaltyApplied }]`
   *
   * DDB は schemaless なので table 側の structural 変更は不要 (= attribute を新規追加するだけ)。
   * 旧 row は本 attribute を持たない → 「未 reveal」 と等価。
   */
  hintsRevealed?: readonly HintRevealRecord[];
};

/**
 * [Composite Runtime / Issue #2061] Composite parent coordination record — owns
 * the problem-level identity and target count, not a single provider's deploy
 * fields (those live on each target record). [Issue #2527 Slice 1 step 2] Source
 * of truth; the physical row (`composite-deployment.ts`) adds PK/SK.
 */
export type CompositeParentDeploymentRecord = {
  jobId: string;
  tenantId: string;
  problemId: string;
  runtimeKind: "composite";
  compositeVersion: number;
  targetCount: number;
  status: DeploymentStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  /**
   * [#2063] Team identity shared with every target row. The parent carries them
   * so a reader can confirm the whole composite belongs to one team without
   * fanning out to the targets. Not GSI2-indexed (the parent stays out of the
   * participant teamLoginKey query until a later issue adds an intentional view).
   */
  teamName?: string;
  teamLoginKey?: string;
  /** Reserved bulk-deploy grouping fields copied from the validated request. */
  accountGroupId?: string;
  problemSetId?: string;
};

/**
 * [Composite Runtime / Issue #2061] Composite target record — a full deployment
 * record (so existing execution paths can drive it unchanged) plus parent
 * linkage, with the runtime triple required (a target always names its
 * provider). [Issue #2527 Slice 1 step 2] Source of truth; the physical row
 * (`composite-deployment.ts`) adds PK/SK + the GSI3 parent-lookup keys.
 */
export type CompositeTargetDeploymentRecord = DeploymentRecord & {
  parentDeploymentId: string;
  targetId: string;
  targetOrdinal: number;
  runtimeProvider: string;
  runtimeEngine: string;
  runtimeEntry: string;
  /**
   * [Composite Runtime / Issue #2747] Target dependency + output-binding graph metadata,
   * persisted verbatim from the validated plan (`buildCompositeDeploymentPlan`). Immutable
   * target identity — see `composite-materialization.ts` — so a retry cannot silently change
   * the graph already persisted for a parent. Absent on legacy (pre-#2747) target rows, which
   * `composite-dispatch.ts` / `composite-detail.ts` treat as "no explicit dependencies" (declaration
   * order stays the only ordering signal, matching the #2066 behavior those rows were created under).
   */
  compositeExecutionWave?: number;
  compositeDependsOn?: readonly string[];
  compositeInputs?: Readonly<Record<string, CompositeInputBinding>>;
  compositeOutputs?: Readonly<Record<string, CompositeOutputDeclaration>>;
};

/**
 * [Issue #2441 / Phase B2] Result of one conditional Deployment mutation. Mirrors
 * {@link EventMutationOutcome}: DynamoDB CCFs stay inside the seam, and methods
 * only carry `record` when the pre-seam write returned a post-image or explicitly
 * probed after a condition failure.
 */
export type DeploymentMutationOutcome =
  | { readonly outcome: "updated"; readonly record?: DeploymentRecord }
  | { readonly outcome: "conflict"; readonly record?: DeploymentRecord }
  | { readonly outcome: "not_found" };

export interface DeploymentKindScoringResult {
  readonly scoreDelta: number;
  readonly lastResult?: DeploymentRecord["lastResult"];
  readonly endpointsHealthJson?: string;
  readonly attackProbesJson?: string;
  readonly postureJson?: string;
  readonly platform?: string;
  readonly newState?: unknown;
}

export interface DeploymentSchedulePatch {
  readonly startsAt?: string;
  readonly endsAt?: string;
}

export interface BulkDeploymentCreateEntry {
  readonly record: DeploymentRecord;
  readonly replacesJobId?: string;
}

/**
 * [Issue #2441 / Phase B1] The domain shape of one `EVENT#<isoTs>#<ulid>` score
 * event row (the sparse scoring-history sub-aggregate that co-habits the
 * `DEPLOYMENT#<jobId>` partition). Written by `shared/score-event.ts`; read by
 * the four timeline sites (battle-attacks / score-events /
 * leaderboard-score-events / team-score-events). [Issue #2527 Slice 1 step 2]
 * Source of truth; the physical row (`shared/score-event.ts`'s `ScoreEventItem`)
 * adds the base PK/SK.
 */
export type ScoreEventRecord = {
  jobId: string;
  problemId: string;
  /** Phase 2a 以前の旧 deployment は持たない (= history 列も undefined)。 */
  teamId?: string;
  eventId?: string;
  /**
   * イベント発生源。
   * - `uptime`: HealthCheck の probe で全 endpoint OK
   * - `flag`: 競技者の flag 提出が正解
   * - `flag-wrong`: 競技者の flag 提出が不正解で wrongAnswerPenalty が減点された (Issue #817)
   * - `attack-detected`: HealthCheck で `lastResult: ok → fail` 遷移を検知し、
   *   Battle Portal の Attack Statistics / History で使う
   * - `hint`: 競技者がヒントを開封し penalty が deduct された (Issue #1038 P1 #8、 2026-05-18)。
   *   旧来 hint reveal は score を直 ADD するだけで score event 履歴に出ず、 「-30 pt なのに
   *   履歴 0 件」 表示の不整合になっていた。
   * - `gate-bonus`: Progression Gate (Issue #2283) の完了 bonus。 team override の
   *   `completionBonus` を Gate challenge 完了時に 1 度だけ加算した marker。
   */
  source:
    | "uptime"
    | "flag"
    | "flag-wrong"
    | "attack-detected"
    | "hint"
    | "gate-bonus"
    | "coordination";
  /**
   * 加算ポイント。`uptime` = scoring.pointsPerSuccess、`flag` = scoring.points、
   * `flag-wrong` = -wrongAnswerPenalty (= 減点、 負数)、 `attack-detected` = 0 (= イベント marker のみ)、
   * `hint` = -hint.penalty (= 減点、 負数)、 `gate-bonus` = teamOverrides[].completionBonus (= 正数)。
   */
  points: number;
  /** Allowlisted public explanation for a coordination score change. */
  reason?: string;
  /**
   * 結果。
   * - `ok`: `uptime` で全 endpoint OK or `flag` で正解 or `hint` 開封成功
   * - `wrong`: `flag-wrong` (= 不正解で減点、 Issue #817)
   * - `down`: `attack-detected` (= 攻撃が刺さって uptime が落ちた)
   *
   * Phase 2 以前の event 行は `"ok"` のみ書かれているので backward compatible。
   */
  result: "ok" | "wrong" | "down";
  occurredAt: string;
  /** 親 deployment の TTL を継承。0 なら無期限 (旧 deployment 互換)。 */
  expiresAt: number;
};

/**
 * [Issue #2441 / Phase B1] The domain shape of one `INBOX#<isoTs>#<ulid>`
 * inter-team cast/inbox row (#1420) — a second sparse sub-aggregate
 * in the `DEPLOYMENT#<jobId>` partition, distinct from score events. Written and
 * read by `participant-handler/cast-event.ts`. The base PK/SK are stripped as in
 * every other record here.
 */
export interface InboxEventRecord {
  readonly eventId?: string;
  readonly fromTeamId?: string;
  readonly fromJobId?: string;
  readonly kind?: string;
  readonly payload?: unknown;
  readonly occurredAt?: string;
  readonly ttl?: number;
}

/**
 * [Issue #2441 / Phase B1] The domain shape of the per-event inter-team
 * coordination state (`COORD#<tenantId>#<eventId>` / SK `STATE`).
 * Mirrors the pre-seam `CoordinationStateRow` (`coordination-store.ts`): the
 * opaque plugin `state` plus its optimistic-lock `version` (0 when the row is
 * absent). The version predicate write is B2/B3 (conditional-write seam).
 */
export interface CoordinationStateRecord {
  /**
   * [Issue #3150] Opaque to the repository, but NOT opaque to every reader:
   * since this issue, `state` is wrapped in the platform's schema-version
   * envelope by the store layer (`coordination-store.ts`'s
   * `writeCoordinationState` / `readCoordinationState`). A consumer that
   * reads this record directly from the repository -- bypassing that store
   * layer -- gets the envelope, not the plugin's state, and must unwrap it
   * itself. A row written before this issue carries no envelope and is the
   * plugin's raw state, same as always.
   */
  readonly state: unknown;
  readonly version: number;
  /**
   * [Issue #3123] The row's TTL (epoch seconds), or `undefined` for a row
   * written before the TTL existed. Returned so the tick host can tell a row
   * that is drifting toward expiry from one just written, and refresh it
   * without a version-bumping write — see `touchCoordinationState`.
   */
  readonly expiresAt?: number;
}

/**
 * [Issue #2441 / Phase B1] One page of {@link DeploymentsRepository.listByTenantPage}.
 * `nextCursor` is an **opaque** token — the pre-seam `list.ts` cursor codec
 * (base64url `ExclusiveStartKey`, allowlist `PK/SK/GSI1PK/GSI1SK/GSI2PK/GSI2SK`),
 * byte-identical wire format so a cursor already handed to a UI mid-pagination
 * stays valid. Callers must not decode it themselves.
 */
export interface DeploymentsPage {
  readonly items: readonly DeploymentRecord[];
  readonly nextCursor?: string;
}
