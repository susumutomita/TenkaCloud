import type { EventBridgeClient, PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";
import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { z } from "zod";
import { logDeployTrace } from "./trace-log.js";

/**
 * Deploy backend で流れる EventBridge イベントの定義。
 *
 * MVP-1: tenant API Lambda が `DeployCreateRequested` を publish し、
 * EventBridge Rule が Step Functions State Machine を起動する流れ。Producer (tenant API)
 * と Consumer (State Machine input transformer) で同じシンボルを参照させ、文字列 drift
 * を防ぐ。
 *
 * `EVENT_SOURCE` は `tenkacloud.deploy` に固定する。Update / Delete 系イベントが増えるときも
 * 同じ source を使い、detail-type で分岐する。
 */

export const EVENT_SOURCE = "tenkacloud.deploy" as const;
export const EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED = "DeployCreateRequested" as const;
export const EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED = "DeployDeleteRequested" as const;
/**
 * Issue #910 (#895 Phase 2.C): bulk batch (= 1 event で N×M deployments) を Distributed Map
 * state machine に渡すための event type。 detail に S3 URI を載せ、 state machine が
 * S3JsonItemReader で deployments 配列を読む。 個別 deploy は `DeployCreateRequested` (=
 * 単発経路) を使い続け、 bulk と単発を異なる EventBridge Rule で 2 つの state machine に
 * route する。
 */
export const EVENT_DETAIL_TYPE_BULK_DEPLOY_CREATE_REQUESTED = "BulkDeployCreateRequested" as const;

/**
 * Issue #1314: 競技者 IAM Role 名は **Application Plane (= tenantId) ごとに unique** に
 * 生成する。 同一 AWS account が 別 Plane / 別 event に並列参加するときに固定名
 * (`TenkaCloud-CompetitorDeploy-Role`) を再利用すると CFn create-stack が
 * `AlreadyExistsException` で fail するため、 Plane scope の namespace を含める。
 *
 * 命名規約:
 *
 *   TenkaCloud-{tenantId}-{namespace}-Role
 *
 * - `tenantId`: Application Plane の識別子 (Lite mode は `"local"`)。
 * - `namespace`: event / scenario 単位の suffix (default `"deploy"`)。 同 tenant 内で
 *   さらに複数 deploy 経路を扱うときに operator が区別できるようにする。
 *
 * IAM Role 名の charclass (`[A-Za-z0-9_+=,.@-]{1,64}`) は CFn `competitor-bootstrap.yaml` の
 * `AllowedPattern` と一致。 invalid char (空白 / `/` 等) を呼び側が混入させると AWS が
 * reject するため、 generator 側で sanitize する責任を持つ。
 *
 * Backward-compat: 既存 DDB レコードの `competitorRoleName` は そのまま読まれる
 * (= AssumeRole 経路は DDB を source of truth にしている)。 新規追加 (= AddAccountModal)
 * の提案 default のみ本 helper が source。
 */
const IAM_ROLE_SANITIZE_RE = /[^A-Za-z0-9_+=,.@-]+/g;
const IAM_ROLE_MAX_LENGTH = 64;

function trimBoundaryDashes(input: string): string {
  let start = 0;
  while (input[start] === "-") start += 1;

  let end = input.length;
  while (end > start && input[end - 1] === "-") end -= 1;

  return input.slice(start, end);
}

function sanitizeRoleSegment(segment: string): string {
  return trimBoundaryDashes(segment.replace(IAM_ROLE_SANITIZE_RE, "-"));
}

export function defaultCompetitorRoleName(opts: { tenantId: string; namespace?: string }): string {
  const tenant = sanitizeRoleSegment(opts.tenantId) || "tenant";
  const ns = sanitizeRoleSegment(opts.namespace ?? "deploy") || "deploy";
  const candidate = `TenkaCloud-${tenant}-${ns}-Role`;
  if (candidate.length <= IAM_ROLE_MAX_LENGTH) return candidate;
  // 64 文字超過時は tenant segment を truncate (= 末尾 `-Role` は保持)。
  const suffix = `-${ns}-Role`;
  const prefix = "TenkaCloud-";
  const room = IAM_ROLE_MAX_LENGTH - prefix.length - suffix.length;
  const truncated = tenant.slice(0, Math.max(1, room));
  return `${prefix}${truncated}${suffix}`;
}

const CORE_PROBLEM_DIR = /^problems\/[a-z0-9-]+\/[a-z0-9-]+$/;
const PACK_ID_SEGMENT = "[a-z0-9]+(?:-[a-z0-9]+)*(?:\\.[a-z0-9]+(?:-[a-z0-9]+)*)+";
const PACK_VERSION_SEGMENT = "[a-z0-9]+(?:[.-][a-z0-9]+)*";
const PACK_PROBLEM_DIR = new RegExp(
  `^pack-problems/${PACK_ID_SEGMENT}/${PACK_VERSION_SEGMENT}/[a-z0-9-]+/[a-z0-9-]+$`,
);

function isProblemDir(value: string): boolean {
  return CORE_PROBLEM_DIR.test(value) || PACK_PROBLEM_DIR.test(value);
}

/**
 * `DeployCreateRequested` event の `detail` schema。tenant API Lambda が publish 時に
 * validate し、Step Functions State Machine の `CodeBuildStartBuild` task が
 * `$.detail.problemDir` / `$.detail.teamSlug` を environmentVariablesOverride で
 * CodeBuild に渡す。
 *
 * `problemDir` は `scripts/deploy-battles.sh` への引数になる (例: `problems/challenges/hello-world`)。
 * `teamSlug` は同 script の `TEAM_SLUG` env として渡る (UI の teamName を slugify したもの)。
 */
export const DeployCreateRequestedDetailSchema = z.object({
  jobId: z.string().min(1),
  correlationId: z.string().min(1).optional(),
  tenantId: z.string().min(1),
  problemId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  problemDir: z.string().refine(isProblemDir, {
    message:
      "problemDir must be problems/<category>/<problem> or pack-problems/<reverse-dns-pack-id>/<version>/<category>/<problem>",
  }),
  teamSlug: z.string().min(1).max(40),
  namePrefix: z.string().regex(/^tc-[a-z0-9]+(?:-[a-z0-9]+)+$/),
  region: z.string().regex(/^[a-z]{2}-[a-z]+-\d+$/),
  awsAccountId: z.string().regex(/^\d{12}$/),
  /**
   * Phase 2.2 (Issue #459): cross-account deploy 用の AssumeRole 対象 RoleArn
   * (= `arn:aws:iam::<awsAccountId>:role/<competitorRoleName>`)。CodeBuild が
   * `aws sts assume-role` を実行するときに使う。verified=true な行が CompetitorAccounts
   * DDB にあるときのみ詰める。同 account deploy (= dev fallback) では undefined。
   */
  competitorRoleArn: z.string().optional(),
  /**
   * Phase 2.2: SSM SecureString path (`/<env>/tenants/<tenantId>/external-id`)。
   * CodeBuild が `aws ssm get-parameter --with-decryption` で ExternalId を取り、
   * AssumeRole の `--external-id` に渡す。`competitorRoleArn` と同時にのみ詰める。
   */
  externalIdParameterName: z.string().optional(),
  /**
   * Issue #642: private 問題用の短命 (15 分 TTL) presigned URL。
   * deploy-handler が `metadata.visibility === "private"` で `CHALLENGE_PAYLOAD_BUCKET`
   * env 変数が bind されているときのみ発行する。 CodeBuild の `deploy-battles.sh`
   * がこの URL を fetch して zip 展開する (= PR-638 で実装済)。 public 問題 / 未配線
   * 環境では undefined のままで、 既存の local-path 経路で動作する。
   */
  challengePayloadUrl: z.string().url().optional(),
  /**
   * [Composite Runtime / Issue #2747] Bound Composite input values (downstream parameter name ->
   * resolved upstream output value), computed by `composite-dispatch.ts` before dispatch and
   * forwarded verbatim by `aws-cfn-adapter.ts`. Absent for every single-provider (non-Composite)
   * deploy — those events are byte-identical to pre-#2747. The Lambda deploy path
   * (`cfn-deploy-handler/create-stack.ts`, `deployViaLambda=true`) merges these into the CFn
   * `Parameters` it builds; the default CodeBuild path does not yet consume this field.
   */
  parameters: z.record(z.string(), z.string()).optional(),
});
export type DeployCreateRequestedDetail = z.infer<typeof DeployCreateRequestedDetailSchema>;

/**
 * `DeployDeleteRequested` event の `detail` schema。tenant API Lambda が削除要求時に
 * publish し、`DeployDelete` State Machine が `CodeBuildStartBuild` task で
 * `scripts/delete-battles.sh "$STACK_NAME"` を実行する。
 *
 * `stackName` は CFn StackName (= namePrefix) または StackId (ARN)。同一 account 内のみ
 * (MVP-1)。Phase 2 で cross-account になったら `awsAccountId` を渡して target account の
 * Role を AssumeRole する。
 */
export const DeployDeleteRequestedDetailSchema = z.object({
  jobId: z.string().min(1),
  correlationId: z.string().min(1).optional(),
  tenantId: z.string().min(1),
  stackName: z.string().min(1),
  region: z.string().regex(/^[a-z]{2}-[a-z]+-\d+$/),
  awsAccountId: z.string().regex(/^\d{12}$/),
  /** Phase 2.2: AssumeRole 対象 RoleArn (delete 経路。`DeployCreateRequestedDetail` と同じ役割)。 */
  competitorRoleArn: z.string().optional(),
  /** Phase 2.2: SSM SecureString path (delete 経路)。 */
  externalIdParameterName: z.string().optional(),
});
export type DeployDeleteRequestedDetail = z.infer<typeof DeployDeleteRequestedDetailSchema>;

/**
 * Issue #910 (#895 Phase 2.C): `BulkDeployCreateRequested` event の `detail` schema。
 * tenant API Lambda が bulk deploy 時 (= 1 event で N×M deployments) に publish し、
 * `BulkDeployCreate` State Machine が `S3JsonItemReader` で deployment 配列を読み込む。
 *
 * - `s3Bucket` / `s3Key`: deployment 配列 (\`DeployCreateRequestedDetail[]\`) を JSON で保存
 *   した S3 object。 Step Functions の Distributed Map が ItemReader で iteration する
 * - `batchId`: 1 bulk 実行を識別する ULID。各 deployment の CFn stack に Tag として
 *   記録し、operator が後で同じ batch を逆引きできる
 * - `tenantId`: caller tenant の scope。 Distributed Map child execution に渡され、
 *   個別 deploy の TenantId に伝搬する
 */
export const BulkDeployCreateRequestedDetailSchema = z.object({
  batchId: z.string().min(1),
  tenantId: z.string().min(1),
  s3Bucket: z.string().min(1),
  s3Key: z.string().min(1),
  /** batch 内 item 数 (= operator の参考表示用、 state machine の挙動には影響しない)。 */
  itemCount: z.number().int().nonnegative().optional(),
});
export type BulkDeployCreateRequestedDetail = z.infer<typeof BulkDeployCreateRequestedDetailSchema>;

export class ProblemEventPublishError extends Error {
  constructor(
    public readonly detailType: string,
    public readonly jobId: string,
    public readonly reason: string,
  ) {
    super(`EventBridge PutEvents failed for ${detailType} ${jobId}: ${reason}`);
    this.name = "ProblemEventPublishError";
  }
}

/**
 * `tenkacloud.deploy` event を 1 件 publish する shared helper。
 * Resources は `tenkacloud:deployment:<jobId>` で統一し、subscriber が job 単位で
 * filter / 検索しやすいようにする。
 */
export async function publishProblemEvent(args: {
  client: EventBridgeClient;
  busName: string;
  detailType: string;
  jobId: string;
  detail: Record<string, unknown>;
}): Promise<void> {
  const correlationId =
    typeof args.detail.correlationId === "string" && args.detail.correlationId.length > 0
      ? args.detail.correlationId
      : args.jobId;
  const resource = `tenkacloud:deployment:${args.jobId}`;
  const out = await args.client.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: args.busName,
          Source: EVENT_SOURCE,
          DetailType: args.detailType,
          Detail: JSON.stringify(args.detail),
          Resources: [resource],
        },
      ],
    }),
  );
  if ((out.FailedEntryCount ?? 0) === 0) {
    logDeployTrace("deploy.eventbridge.publish.succeeded", {
      jobId: args.jobId,
      correlationId,
      detailType: args.detailType,
      eventBusName: args.busName,
      resource,
    });
    return;
  }
  const failed = out.Entries?.[0];
  throw new ProblemEventPublishError(
    args.detailType,
    args.jobId,
    failed?.ErrorCode
      ? `${failed.ErrorCode}: ${failed.ErrorMessage ?? "unknown error"}`
      : "unknown error",
  );
}

/** EventBridge `PutEvents`'s own limit: at most 10 entries per request. */
export const PUT_EVENTS_BATCH_SIZE = 10;

/** One entry to batch-publish, carrying the caller's own correlation `item` alongside it. */
export interface PutEventsBatchItem<T> {
  readonly item: T;
  readonly entry: PutEventsRequestEntry;
}

/**
 * Per-entry outcome of {@link putEventsBatched}, index-aligned back to the input via `item`
 * (not array index — chunking makes index correlation across chunks error-prone).
 */
export interface PutEventsBatchResult<T> {
  readonly item: T;
  readonly success: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

/**
 * Issue #2210: the chunked `PutEvents` pattern (split into groups of
 * {@link PUT_EVENTS_BATCH_SIZE}, send, check `FailedEntryCount`, map failed entries by
 * index-aligned `ErrorCode`) was reimplemented in 4 handler call sites — one of which
 * (`disruption-fire.ts`) redefined its own local `BATCH = 10` constant, and another
 * (`condition-disruption-fire.ts`) didn't chunk at all (a latent bug once more than 10
 * disruption targets fire at once). This is the single shared implementation; each caller
 * only owns turning `PutEventsBatchResult[]` into its own failure shape (a jobId list, a
 * `PublishFailure[]`, or a thrown `Error`) — that mapping differs by design per call site
 * and stays there.
 */
export async function putEventsBatched<T>(
  client: EventBridgeClient,
  items: readonly PutEventsBatchItem<T>[],
): Promise<PutEventsBatchResult<T>[]> {
  const chunks: PutEventsBatchItem<T>[][] = [];
  for (let i = 0; i < items.length; i += PUT_EVENTS_BATCH_SIZE) {
    chunks.push(items.slice(i, i + PUT_EVENTS_BATCH_SIZE));
  }
  const results = await Promise.all(chunks.map((chunk) => sendPutEventsChunk(client, chunk)));
  return results.flat();
}

async function sendPutEventsChunk<T>(
  client: EventBridgeClient,
  chunk: readonly PutEventsBatchItem<T>[],
): Promise<PutEventsBatchResult<T>[]> {
  try {
    const out = await client.send(new PutEventsCommand({ Entries: chunk.map((c) => c.entry) }));
    if ((out.FailedEntryCount ?? 0) === 0) {
      return chunk.map((c) => ({ item: c.item, success: true }));
    }
    // PutEvents response.Entries is index-aligned with the request Entries.
    return chunk.map((c, i) => {
      const entry = out.Entries?.[i];
      if (entry?.ErrorCode) {
        return {
          item: c.item,
          success: false,
          errorCode: entry.ErrorCode,
          errorMessage: entry.ErrorMessage ?? "unknown error",
        };
      }
      return { item: c.item, success: true };
    });
  } catch (err) {
    // The whole chunk's request rejected (network/throttling) — every entry in it is
    // unpublished, matching the pre-existing per-call-site "chunk reject → all failed" handling.
    const reason = err instanceof Error ? err.message : String(err);
    return chunk.map((c) => ({ item: c.item, success: false, errorMessage: reason }));
  }
}
