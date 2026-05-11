import {
  CloudFormationClient,
  DescribeStackEventsCommand,
  DescribeStackResourcesCommand,
  type StackEvent,
  type StackResource,
} from "@aws-sdk/client-cloudformation";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
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
   * region 別の CFn client を返す factory。region は同一 account に固定 (MVP-1) なので
   * AssumeRole は不要。テスト時には mock client を返す stub に差し替える。
   */
  readonly cfnClient: (region: string) => CloudFormationClient;
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
  const stackRef = item.stackId ?? stackName;
  const cfn = deps.cfnClient(region);

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
    },
  };
}
