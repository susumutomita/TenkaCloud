import { PutEventsCommand, type PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { buildStackPrefix, slugify } from "../deploy-handler/naming.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import {
  resolveVerifiedCompetitorAccount,
  type VerifiedCompetitorAccount,
} from "../shared/competitor-account-lookup.js";
import {
  type DeployCreateRequestedDetail,
  EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED,
  EVENT_SOURCE,
} from "../shared/events.js";
import { type EventSharedResources, queryDeploymentsByEvent } from "./shared.js";
import type { BulkDeployRequest, EventItem, EventProblemTarget, TeamItem } from "./types.js";

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

const TRANSACT_WRITE_BATCH = 25;
const PUT_EVENTS_BATCH = 10;

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const toEpochSeconds = (ms: number): number => Math.floor(ms / 1000);

/**
 * `bulkDeployEvent` は Event / Teams を読み、選択された problems 全てに対して
 * teams × problems の deployment 行を一括 PUT し、既存 `DeployCreateRequested` を
 * 個別に publish する (= EventBridge fan-out)。
 *
 * 各 deployment 行は eventId / teamId / teamLoginKey (Team 行と同値) を持ち、
 * Phase 2c の Participant Portal は teamLoginKey で `team の全 deployment` を引ける。
 *
 * 既存 deployment と (eventId, teamId, problemId) が衝突する場合は in-memory で
 * 検出して skipped に計上する (= 後追い deploy で既行を二重生成しない)。
 *
 * `tenantId` mismatch / event 不在は `not_found`。teams / problems 両方 0 件はそのまま
 * `enqueued: 0` を返す (= operator の即時 dry-run 用途)。
 *
 * `request` (#555):
 *   - `undefined` / `{}` → 従来通り全展開 (= 既存衝突分のみ skip)
 *   - `{ retryFailedOnly: true }` → FAILED 状態の旧行を DELETE → 同 (teamId, problemId) で
 *     新 jobId の PENDING を CREATE。旧 jobId は失われる (= 履歴より状態のクリーンさを優先、
 *     failureReason の monitoring は publish 直後の CloudWatch Logs に残る)。
 *   - `{ teamIds }` / `{ problemIds }` → 範囲を絞る (後追い team / 問題用)
 *   - 組み合わせ可能 (= `{ retryFailedOnly: true, teamIds: [t1] }` で「team t1 の失敗のみ retry」)
 */
export async function bulkDeployEvent(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  nowMs: number,
  request?: BulkDeployRequest,
): Promise<BulkDeployOutcome> {
  // Event Get と Teams Query は依存なし → Promise.all で 1 ラウンドトリップ節約。
  // 不正 eventId のとき teams query が無駄になるが空 partition で 1 RCU 程度。
  const [eventOut, teamsOut] = await Promise.all([
    shared.ddb.send(
      new GetCommand({
        TableName: shared.eventsTableName,
        Key: { PK: `EVENT#${eventId}`, SK: "META" },
      }),
    ),
    shared.ddb.send(
      new QueryCommand({
        TableName: shared.teamsTableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :tprefix)",
        ExpressionAttributeValues: { ":pk": `EVENT#${eventId}`, ":tprefix": "TEAM#" },
      }),
    ),
  ]);
  const event = eventOut.Item as Partial<EventItem> | undefined;
  if (!event || event.tenantId !== tenantId) return { kind: "not_found" };

  const allTeams = (teamsOut.Items ?? []) as TeamItem[];
  const allProblems = (Array.isArray(event.problems) ? event.problems : []) as EventProblemTarget[];
  if (allTeams.length === 0 || allProblems.length === 0) {
    return { kind: "ok", result: { eventId, enqueued: 0, skipped: 0 } };
  }

  // #555: opt-in filter / retry-failed の選択肢を解釈する。
  //   - teamIds / problemIds → in-memory で範囲を絞る (= 後追い team / 問題用)。
  //   - retryFailedOnly → 既存 FAILED 行を query し、その (teamId, problemId) に絞る。
  //     旧 FAILED 行は後段 TransactWrite で Put + Delete を 1 transaction にし、jobId を
  //     更新する (履歴より状態のクリーンさを優先 — Issue #555 設計判断)。
  const teamIdFilter = request?.teamIds ? new Set(request.teamIds) : undefined;
  const problemIdFilter = request?.problemIds ? new Set(request.problemIds) : undefined;
  const teams = teamIdFilter ? allTeams.filter((t) => teamIdFilter.has(t.teamId)) : allTeams;
  const problems = problemIdFilter
    ? allProblems.filter((p) => problemIdFilter.has(p.problemId))
    : allProblems;
  if (teams.length === 0 || problems.length === 0) {
    return { kind: "ok", result: { eventId, enqueued: 0, skipped: 0 } };
  }

  // #555: 既存 deployment 行を読む。retryFailedOnly のときは「FAILED 行のみを再生成」
  // の対象 set を作る目的、それ以外でも「(eventId, teamId, problemId) 衝突は in-memory
  // skip」に使う (= 後追い deploy の二重生成防止)。
  const existingDeployments = await queryDeploymentsByEvent(
    shared,
    tenantId,
    eventId,
    "jobId, teamId, problemId, #s",
  );
  // (teamId, problemId) → 旧 FAILED 行の jobId (retryFailedOnly のとき DELETE 対象)。
  const failedByKey = new Map<string, { jobId: string }>();
  // (teamId, problemId) → status を問わず存在する組 (skipped 計算用)。
  const existingKey = new Set<string>();
  for (const d of existingDeployments) {
    const tId = String(d.teamId ?? "");
    const pId = String(d.problemId ?? "");
    if (!tId || !pId) continue;
    const k = `${tId} ${pId}`;
    existingKey.add(k);
    if (d.status === "FAILED" && !failedByKey.has(k)) {
      failedByKey.set(k, { jobId: String(d.jobId ?? "") });
    }
  }
  const retryFailedOnly = request?.retryFailedOnly === true;
  // retryFailedOnly でかつ FAILED 行が 0 件 → 何もしない (= enqueued: 0、skipped: 0)。
  if (retryFailedOnly && failedByKey.size === 0) {
    return { kind: "ok", result: { eventId, enqueued: 0, skipped: 0 } };
  }

  // Phase 2.2 (Issue #459): bulk-deploy 前に CompetitorAccounts table で verified=true 行が
  // ある (tenantId, awsAccountId) のみ許可する。verified=false / 未登録の team は plan から
  // 落ちる (= unverified にカウント、`unverifiedAccounts` で operator に通知)。
  //
  // teams × problems の plan ループに入る前に 1 度だけ解決して in-memory map 化する。
  // problem.defaultAwsAccountId fallback 経路も同じ map で評価できるよう、unique な
  // awsAccountId set を作って一度に解決する。
  const candidateAccountIds = new Set<string>();
  for (const t of teams) if (t.awsAccountId) candidateAccountIds.add(t.awsAccountId);
  for (const p of problems)
    if (p.defaultAwsAccountId) candidateAccountIds.add(p.defaultAwsAccountId);
  const verifiedByAccount = new Map<string, VerifiedCompetitorAccount>();
  await Promise.all(
    Array.from(candidateAccountIds).map(async (aId) => {
      const v = await resolveVerifiedCompetitorAccount(
        {
          ddb: shared.ddb,
          competitorAccountsTableName: shared.competitorAccountsTableName,
          env: shared.env,
        },
        tenantId,
        aId,
      );
      if (v) verifiedByAccount.set(aId, v);
    }),
  );

  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = toEpochSeconds(nowMs + DEFAULT_TTL_MS);
  // Event.startsAt が未設定 = 競技開始時刻が決まっていないので採点開始しない gate に倒す。
  // operator は EventDetail の「日時を設定」or「即座に開始」で後から有効化できる。
  const eventStartsAt = typeof event.startsAt === "string" ? event.startsAt : undefined;
  // Event.endsAt が設定済 (= 既に終了済 event) なら deploy 行にも denormalize して
  // 採点 gate を即時 close する。READY 状態のみ end-event 可能なので通常は undefined。
  const eventEndsAt = typeof event.endsAt === "string" ? event.endsAt : undefined;

  // teams × problems を全展開し、deployment 行 + publish entry を組み立てる。
  // shared.problemsCatalog (problemId → problemDir) に存在しない problemId は skip。
  // #528: deploy target の awsAccountId は team から (= 各 team は自社 AWS account)、region は
  // problem から (= 問題テンプレが特定 region 依存)。team.awsAccountId が無い旧 Event は
  // problem.defaultAwsAccountId に fallback (Phase 2 で fallback も削除予定)。
  interface PlanEntry {
    readonly item: DeploymentItem;
    readonly entry: PutEventsRequestEntry;
    /** retryFailedOnly = true のとき、対応する旧 FAILED 行の jobId (= これを DELETE)。 */
    readonly replacesJobId?: string;
  }
  const plan: PlanEntry[] = [];
  let skipped = 0;
  const unverifiedAccounts = new Set<string>();
  for (const team of teams) {
    const teamAwsAccountId = team.awsAccountId;
    for (const problem of problems) {
      const k = `${team.teamId} ${problem.problemId}`;
      if (retryFailedOnly) {
        // FAILED で無い組み合わせは対象外 (= silent skip、skipped にも計上しない)。
        if (!failedByKey.has(k)) continue;
      } else if (existingKey.has(k)) {
        // 既存 (status を問わず) と衝突 → idempotent skip (全展開 / 部分指定 共通)。
        skipped++;
        continue;
      }
      const problemDir = shared.problemsCatalog[problem.problemId];
      if (!problemDir) {
        skipped++;
        continue;
      }
      // #528: team.awsAccountId が新 source-of-truth。旧 Event は problem.defaultAwsAccountId
      // を fallback として使う。両方無いと deploy target を組めないので skip。
      const awsAccountId = teamAwsAccountId ?? problem.defaultAwsAccountId;
      if (!awsAccountId) {
        skipped++;
        continue;
      }
      // Phase 2.2 (Issue #459): verified=true な行が無い account は reject。
      // plan に乗せない (= worker が走らない) ため fail-closed。
      const verified = verifiedByAccount.get(awsAccountId);
      if (!verified) {
        unverifiedAccounts.add(awsAccountId);
        continue;
      }
      const jobId = ulid();
      const namePrefix = buildStackPrefix(problem.problemId, team.internalSlug);
      const teamSlug = slugify(team.internalSlug);
      const item: DeploymentItem = {
        PK: `DEPLOYMENT#${jobId}`,
        SK: "META",
        GSI1PK: `TENANT#${tenantId}`,
        GSI1SK: createdAt,
        GSI2PK: `TEAMKEY#${team.teamLoginKey}`,
        GSI2SK: createdAt,
        jobId,
        problemId: problem.problemId,
        tenantId,
        awsAccountId,
        region: problem.defaultRegion,
        teamName: team.internalSlug,
        namePrefix,
        teamLoginKey: team.teamLoginKey,
        status: "PENDING",
        createdAt,
        updatedAt: createdAt,
        expiresAt,
        eventId,
        teamId: team.teamId,
        eventStartsAt,
        eventEndsAt,
      };
      const detail: DeployCreateRequestedDetail = {
        jobId,
        tenantId,
        problemId: problem.problemId,
        problemDir,
        teamSlug,
        namePrefix,
        region: problem.defaultRegion,
        awsAccountId,
        // Phase 2.2: cross-account 経路で CodeBuild が AssumeRole に使う metadata。
        // verified=true 行が解決できたときのみ詰める (= 未指定なら same-account fallback)。
        competitorRoleArn: verified.competitorRoleArn,
        externalIdParameterName: verified.externalIdParameterName,
      };
      const entry: PutEventsRequestEntry = {
        EventBusName: shared.eventBusName,
        Source: EVENT_SOURCE,
        DetailType: EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED,
        Detail: JSON.stringify(detail),
        Resources: [`tenkacloud:deployment:${jobId}`],
      };
      plan.push({
        item,
        entry,
        replacesJobId: retryFailedOnly ? failedByKey.get(k)?.jobId : undefined,
      });
    }
  }

  if (plan.length === 0) {
    return {
      kind: "ok",
      result: buildResult({ eventId, enqueued: 0, skipped, unverifiedAccounts }),
    };
  }

  // DDB TransactWrite は 1 call 25 items まで (Put + Delete を合算)。retryFailedOnly では
  // 1 plan entry につき Put + Delete の 2 op が要るので chunk 上限を半減させる。
  // ConditionExpression で同 jobId 二重生成を防ぐ (ULID 衝突は実質起こらないが defense)。
  const opsPerEntry = retryFailedOnly ? 2 : 1;
  const planPerChunk = Math.floor(TRANSACT_WRITE_BATCH / opsPerEntry);
  const transactChunks: Promise<unknown>[] = [];
  for (let i = 0; i < plan.length; i += planPerChunk) {
    const chunk = plan.slice(i, i + planPerChunk);
    const transactItems: TransactWriteCommandInput["TransactItems"] = [];
    for (const p of chunk) {
      transactItems.push({
        Put: {
          TableName: shared.deploymentsTableName,
          Item: p.item,
          ConditionExpression: "attribute_not_exists(PK)",
        },
      });
      if (p.replacesJobId) {
        // 旧 FAILED 行を同 transaction で DELETE (= jobId 履歴より状態のクリーンさを優先、
        // failureReason の monitoring は publish 直後の CloudWatch Logs に残る)。
        // tenantId で cross-tenant 削除を防ぐ ConditionExpression を必ず付ける。
        transactItems.push({
          Delete: {
            TableName: shared.deploymentsTableName,
            Key: { PK: `DEPLOYMENT#${p.replacesJobId}`, SK: "META" },
            ConditionExpression: "tenantId = :tenantId",
            ExpressionAttributeValues: { ":tenantId": tenantId },
          },
        });
      }
    }
    transactChunks.push(
      shared.ddb.send(new TransactWriteCommand({ TransactItems: transactItems })),
    );
  }
  await Promise.all(transactChunks);

  const items = plan.map((p) => p.item);
  const entries = plan.map((p) => p.entry);

  // EventBridge PutEvents は 1 call 10 entries まで。chunk を Promise.all で並列発火。
  // 途中で publish が失敗した chunk があると半端な行が残るが、operator が再度 deploy を
  // 呼ぶと既行は idempotent skip され、未 publish 分だけ publish される (= 結果整合性)。
  const putChunks: Promise<unknown>[] = [];
  for (let i = 0; i < entries.length; i += PUT_EVENTS_BATCH) {
    const chunk = entries.slice(i, i + PUT_EVENTS_BATCH);
    putChunks.push(shared.events.send(new PutEventsCommand({ Entries: chunk })));
  }

  // Event status を DRAFT → DEPLOYING に倒す。operator が EventDetail の status badge で
  // 「Bulk Deploy が走っている」ことを視認できるようにするため。
  // ConditionExpression で他 status (TEARDOWN 等) を踏み越えない安全弁。CCF は
  // 既に TEARDOWN/ARCHIVED 等の終端状態 → 触らないだけで成功扱い。
  // PutEvents と並列実行 (互いに依存なし、書き込み先が別 service なのでラウンドトリップ節約)。
  const updateStatus = shared.ddb
    .send(
      new UpdateCommand({
        TableName: shared.eventsTableName,
        Key: { PK: `EVENT#${eventId}`, SK: "META" },
        UpdateExpression: "SET #status = :deploying, updatedAt = :now",
        ConditionExpression: "#status = :draft OR #status = :ready OR #status = :deploying",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":deploying": "DEPLOYING",
          ":draft": "DRAFT",
          ":ready": "READY",
          ":now": createdAt,
        },
      }),
    )
    .catch((err: unknown) => {
      if (err instanceof Error && err.name !== "ConditionalCheckFailedException") {
        throw err;
      }
    });
  await Promise.all([...putChunks, updateStatus]);

  return {
    kind: "ok",
    result: buildResult({ eventId, enqueued: items.length, skipped, unverifiedAccounts }),
  };
}

/**
 * Phase 2.2 (Issue #459): result builder。`unverifiedAccounts` が空のときは
 * `unverified` / `unverifiedAccounts` フィールド自体を出さない (= 既存 client が
 * 後方互換)。あるときは sorted array で安定出力する (= operator UI 表示用)。
 */
function buildResult(args: {
  readonly eventId: string;
  readonly enqueued: number;
  readonly skipped: number;
  readonly unverifiedAccounts: Set<string>;
}): BulkDeployResult {
  const base: BulkDeployResult = {
    eventId: args.eventId,
    enqueued: args.enqueued,
    skipped: args.skipped,
  };
  if (args.unverifiedAccounts.size === 0) return base;
  return {
    ...base,
    unverified: args.unverifiedAccounts.size,
    unverifiedAccounts: Array.from(args.unverifiedAccounts).sort(),
  };
}
