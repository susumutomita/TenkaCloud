import {
  CloudFormationClient,
  DescribeStackEventsCommand,
  DescribeStackResourcesCommand,
  type StackEvent,
  type StackResource,
} from "@aws-sdk/client-cloudformation";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { buildCfnStuckDiagnosis, type StackStuckDiagnosis } from "../shared/cfn-stuck.js";
import { resolveVerifiedCompetitorAccount } from "../shared/competitor-account-lookup.js";
import type { DeploySharedResources } from "./deploy.js";
import type { DeploymentItem } from "./types.js";

export interface StackProgressEvent {
  readonly timestamp: string;
  readonly logicalResourceId: string;
  readonly resourceType: string;
  readonly resourceStatus: string;
  readonly resourceStatusReason?: string;
}

export interface StackProgressResource {
  readonly logicalResourceId: string;
  readonly resourceType: string;
  readonly resourceStatus: string;
  readonly resourceStatusReason?: string;
  readonly physicalResourceId?: string;
}

export interface StackProgress {
  readonly jobId: string;
  readonly stackName: string;
  readonly region: string;
  /** Console deep link (= `https://<region>.console.aws.amazon.com/cloudformation/...`) */
  readonly consoleUrl: string;
  /** 時系列降順 (最新が先頭) で最大 `EVENTS_LIMIT` 件。 */
  readonly events: readonly StackProgressEvent[];
  /** Stack に紐づく resource 一覧 (logicalId asc)。 */
  readonly resources: readonly StackProgressResource[];
  /**
   * CFn API で stack を引いた瞬間に分かる stack 状態 (= `CREATE_IN_PROGRESS` 等)。
   * UI で「全体としての現在の CFn 状態」を 1 行で出すために使う。
   */
  readonly stackStatus?: string;
  readonly stuck?: StackStuckDiagnosis;
}

export type StackProgressOutcome =
  | { kind: "ok"; progress: StackProgress }
  | { kind: "not_found" }
  | { kind: "stack_not_yet_created" }
  | { kind: "stack_not_found_in_cfn"; consoleUrl: string };

/** UI で見せる stack events 件数 (= 最新から ~20 件)。CFn 1 page で十分。 */
const EVENTS_LIMIT = 20;

/**
 * CloudFormation の region 別 console URL。`stackId` (= ARN) があれば stack detail page
 * に直接飛ぶ。Stack 未作成段階 (= stackId 未割当) では filteringText 経由で stack 一覧から
 * 見つけられる URL を返す (= operator が「これから出てくる stack」を待ち受けられる)。
 */
export function buildCfnConsoleUrl(region: string, stackName: string, stackId?: string): string {
  const base = `https://${region}.console.aws.amazon.com/cloudformation/home?region=${encodeURIComponent(region)}`;
  if (stackId) {
    return `${base}#/stacks/stackinfo?stackId=${encodeURIComponent(stackId)}`;
  }
  return `${base}#/stacks?filteringText=${encodeURIComponent(stackName)}`;
}

function toProgressEvent(e: StackEvent): StackProgressEvent {
  return {
    timestamp: e.Timestamp ? e.Timestamp.toISOString() : "",
    logicalResourceId: e.LogicalResourceId ?? "",
    resourceType: e.ResourceType ?? "",
    resourceStatus: e.ResourceStatus ?? "",
    resourceStatusReason: e.ResourceStatusReason,
  };
}

function toProgressResource(r: StackResource): StackProgressResource {
  return {
    logicalResourceId: r.LogicalResourceId ?? "",
    resourceType: r.ResourceType ?? "",
    resourceStatus: r.ResourceStatus ?? "",
    resourceStatusReason: r.ResourceStatusReason,
    physicalResourceId: r.PhysicalResourceId,
  };
}

/** CFn が「stack なし」を投げる場合に true。SDK エラー名 + message 両方で判定。 */
function isStackNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; message?: unknown };
  if (typeof e.name === "string" && e.name === "ValidationError") {
    // ValidationError は権限不足等もあるが、message に "does not exist" を含む
    // ケース (= CFn が「Stack with id <X> does not exist」を返す) のみ stack 未在として扱う。
    if (typeof e.message === "string" && e.message.includes("does not exist")) return true;
  }
  return false;
}

export interface StackProgressDeps {
  /**
   * region 別の CFn client を返す factory。same-account fallback で使う。
   * Phase 2.2 (Issue #459) cross-account 経路では `cfnClientForCompetitor` 経由で
   * AssumeRole 済 credentials で client を組む (= 本 factory は dev / 未 verify 用)。
   */
  readonly cfnClient: (region: string) => CloudFormationClient;
  /**
   * Phase 2.2: cross-account 用 CFn client を返す factory (default impl は同 module 内
   * `defaultCfnClientForCompetitor`)。tenantId + awsAccountId + region + competitorRoleArn +
   * SSM path から AssumeRole + ExternalId fetch を行い、tmp credentials の CFn client を作る。
   * テスト時には mock client を返す stub に差し替える (= STS call を握り潰す)。
   */
  readonly cfnClientForCompetitor?: (params: {
    readonly region: string;
    readonly competitorRoleArn: string;
    readonly externalIdParameterName: string;
  }) => Promise<CloudFormationClient>;
  readonly now?: () => Date;
}

/** module-scope の lazy cache。region ごとに 1 度だけ build する (warm invoke で再利用)。 */
const clientCache = new Map<string, CloudFormationClient>();
export const defaultCfnClient = (region: string): CloudFormationClient => {
  let c = clientCache.get(region);
  if (!c) {
    c = new CloudFormationClient({ region });
    clientCache.set(region, c);
  }
  return c;
};

/**
 * Phase 2.2 (Issue #459): cross-account CFn client factory の default 実装。
 *
 * 1. SSM SecureString から ExternalId を取得 (= `kms:Decrypt` で復号)
 * 2. STS AssumeRole (with ExternalId) で 15 分 tmp credentials を取得
 * 3. credentials を CloudFormationClient に注入して返す
 *
 * caller (= `getStackProgress`) は session 内で 1 度 build した client を `Promise.all` で
 * 並列に使う (= DescribeStackEvents + DescribeStackResources)。15 分 session 内なら 1 回の
 * AssumeRole で複数 API を捌ける。session を warm Lambda invoke 跨ぎでキャッシュすると鍵
 * 漏洩リスクが上がるので、本実装ではキャッシュしない (cold session every request)。
 */
const moduleSts = new STSClient({});
const moduleSsm = new SSMClient({});

export async function defaultCfnClientForCompetitor(params: {
  readonly region: string;
  readonly competitorRoleArn: string;
  readonly externalIdParameterName: string;
}): Promise<CloudFormationClient> {
  const ssmOut = await moduleSsm.send(
    new GetParameterCommand({ Name: params.externalIdParameterName, WithDecryption: true }),
  );
  const externalId = ssmOut.Parameter?.Value;
  if (!externalId) {
    throw new Error(`ExternalId not found in SSM SecureString: ${params.externalIdParameterName}`);
  }
  const stsOut = await moduleSts.send(
    new AssumeRoleCommand({
      RoleArn: params.competitorRoleArn,
      RoleSessionName: `tenkacloud-stack-progress-${Date.now()}`,
      ExternalId: externalId,
      DurationSeconds: 900,
    }),
  );
  const creds = stsOut.Credentials;
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
    throw new Error("AssumeRole returned incomplete credentials");
  }
  return new CloudFormationClient({
    region: params.region,
    credentials: {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    },
  });
}

/**
 * 指定 jobId の deploy job について、CFn StackEvents / StackResources を取得して
 * UI が表示可能な shape に整える。
 *
 * - DDB に jobId が無い / tenantId mismatch → `not_found` (404 等価)
 * - DDB 行はあるが namePrefix 未割当 → `stack_not_yet_created` (= PENDING の極初期)
 * - CFn から見て stack が無い (= まだ CreateStack 前 / 既に削除済) → `stack_not_found_in_cfn`
 *   この場合は console URL のみ返す (= operator が手動確認可能)。
 *
 * region は DDB 行の `region` を使う。CFn API は同一 account 内 (MVP-1 制約) を想定し、
 * AssumeRole は行わない。Phase 2 で cross-account になったら ExternalId 経由の AssumeRole
 * を追加する。
 */
export async function getStackProgress(
  shared: DeploySharedResources,
  deps: StackProgressDeps,
  tenantId: string,
  jobId: string,
): Promise<StackProgressOutcome> {
  const got = await shared.ddb.send(
    new GetCommand({
      TableName: shared.tableName,
      Key: { PK: `DEPLOYMENT#${jobId}`, SK: "META" },
    }),
  );
  const item = got.Item as Partial<DeploymentItem> | undefined;
  if (!item) return { kind: "not_found" };
  if (item.tenantId !== tenantId) return { kind: "not_found" };

  const stackName = item.namePrefix;
  const region = item.region;
  if (!stackName || !region) return { kind: "stack_not_yet_created" };

  const consoleUrl = buildCfnConsoleUrl(region, stackName, item.stackId);
  // CFn は StackName / StackId のどちらでも引ける。stackId が確定済ならそれを使う
  // (= 万一 stack を delete → 同名再作成した場合に旧 stack の events に混入しない)。
  // #1810 sibling: FAILED deployment は stack ARN 記録前に終わると stackId="" (空文字) になる。
  // `??` は空文字を fallback しないので `||` で namePrefix (= stackName) に倒す (空 StackName で
  // CFn を引くと DescribeStackEvents が失敗し、失敗 deploy の進捗が一切引けなくなるのを防ぐ)。
  const stackRef = item.stackId || stackName;
  // Phase 2.2 (Issue #459): verified=true 行が CompetitorAccounts table にあれば
  // AssumeRole 経由で cross-account client を組む。無ければ同 account 経路 (= dev /
  // 旧 deployment 行 / 未 verify) で従来通り。
  const verified = await resolveVerifiedCompetitorAccount(
    {
      ddb: shared.ddb,
      competitorAccountsTableName: shared.competitorAccountsTableName,
      env: shared.env,
    },
    tenantId,
    String(item.awsAccountId ?? ""),
  );
  const cfn: CloudFormationClient =
    verified && deps.cfnClientForCompetitor
      ? await deps.cfnClientForCompetitor({
          region,
          competitorRoleArn: verified.competitorRoleArn,
          externalIdParameterName: verified.externalIdParameterName,
        })
      : deps.cfnClient(region);

  let events: StackEvent[];
  let resources: StackResource[];
  let stackStatus: string | undefined;
  try {
    // Events と Resources は独立で並列発行 (= 各 ~300ms × 2 を 1 round-trip に圧縮)。
    const [eventsRes, resourcesRes] = await Promise.all([
      cfn.send(new DescribeStackEventsCommand({ StackName: stackRef })),
      cfn.send(new DescribeStackResourcesCommand({ StackName: stackRef })),
    ]);
    events = (eventsRes.StackEvents ?? []).slice(0, EVENTS_LIMIT);
    resources = resourcesRes.StackResources ?? [];
    // 直近 event の `ResourceStatus` が stack 自身 (LogicalResourceId === stackName)
    // ならそれを stack 状態として採用。
    const stackLevel = events.find((e) => e.LogicalResourceId === stackName);
    stackStatus = stackLevel?.ResourceStatus;
  } catch (err) {
    if (isStackNotFoundError(err)) {
      return { kind: "stack_not_found_in_cfn", consoleUrl };
    }
    throw err;
  }

  const sortedResources = [...resources].sort((a, b) =>
    (a.LogicalResourceId ?? "").localeCompare(b.LogicalResourceId ?? ""),
  );

  return {
    kind: "ok",
    progress: {
      jobId,
      stackName,
      region,
      consoleUrl,
      events: events.map(toProgressEvent),
      resources: sortedResources.map(toProgressResource),
      stackStatus,
      stuck: buildCfnStuckDiagnosis({
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        events,
        stackName,
        stackStatus,
        now: deps.now?.() ?? new Date(),
      }),
    },
  };
}
