import {
  CloudFormationClient,
  DescribeStackEventsCommand,
  DescribeStackResourcesCommand,
  type StackEvent,
  type StackResource,
} from "@aws-sdk/client-cloudformation";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildCfnStuckDiagnosis,
  type StackStuckDiagnosis,
} from "../../../problem-deploy/handlers/shared/cfn-stuck.js";
import type { AdminInsightSharedResources } from "./shared.js";

/**
 * Phase 1.B drill-down deployment 詳細 + CFn StackProgress (ADR-011 / #598)。
 *
 * 設計判断:
 * - **read-only / same-account**: Phase 1 では CFn API を tenant 自身の AWS Account
 *   (= Lambda 実行 account = same-account) 内 stack に対してのみ叩く。Phase 2 で
 *   ExternalId 経由の AssumeRole + cross-account StackEvents 読みに拡張する (= ADR-011 D4)。
 * - **teamLoginKey は black-out**: getDeploymentForTenant でも `teamLoginKey` を undefined
 *   に潰す。Tests pin する。
 * - shape は application-admin-console 側の DeploymentSummary / StackProgress と同じ
 *   (= frontend で mirror 描画する)。
 */

type DeploymentStatus = "PENDING" | "IN_PROGRESS" | "COMPLETE" | "FAILED" | "DELETING" | "DELETED";

export interface DeploymentDetail {
  readonly jobId: string;
  readonly problemId: string;
  readonly tenantId: string;
  readonly awsAccountId: string;
  readonly region: string;
  readonly teamName: string;
  readonly displayTeamName?: string;
  readonly namePrefix: string;
  readonly status: DeploymentStatus;
  readonly stackId?: string;
  readonly stackOutputs?: string;
  readonly failureReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: number;
  readonly eventId?: string;
  readonly teamId?: string;
  /**
   * **常に undefined**。System Admin 経路では tenant の短命 bearer を露出しない
   * (ADR-011 D2)。shape 上は frontend mirror のため field を残すが値は出さない。
   */
  readonly teamLoginKey?: undefined;
}

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
  readonly consoleUrl: string;
  readonly events: readonly StackProgressEvent[];
  readonly resources: readonly StackProgressResource[];
  readonly stackStatus?: string;
  readonly stuck?: StackStuckDiagnosis;
}

export type StackProgressOutcome =
  | { kind: "ok"; progress: StackProgress }
  | { kind: "not_found" }
  | { kind: "stack_not_yet_created" }
  | { kind: "stack_not_found_in_cfn"; consoleUrl: string };

const EVENTS_LIMIT = 20;

export function buildCfnConsoleUrl(region: string, stackName: string, stackId?: string): string {
  const base = `https://${region}.console.aws.amazon.com/cloudformation/home?region=${encodeURIComponent(
    region,
  )}`;
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

function isStackNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; message?: unknown };
  if (typeof e.name === "string" && e.name === "ValidationError") {
    if (typeof e.message === "string" && e.message.includes("does not exist")) return true;
  }
  return false;
}

/**
 * 指定 jobId の Deployment 詳細。
 *
 * `tenantId` が caller (System Admin が path param で指定した tenant) と一致しない行は
 * `undefined` で返す。これは「テナント分離をパス境界で再検査する」防御で、admin が誤って
 * 別 tenant の jobId を指定しても他テナントの deploy が見えないようにする。
 *
 * `teamLoginKey` は **必ず undefined**。一覧と同じ規律 (= 詳細経路でも System Admin 経路
 * では短命 bearer を露出しない)。
 */
export async function getDeploymentForTenant(
  shared: AdminInsightSharedResources,
  tenantId: string,
  jobId: string,
): Promise<DeploymentDetail | undefined> {
  const out = await shared.ddb.send(
    new GetCommand({
      TableName: shared.deploymentsTableName,
      Key: { PK: `DEPLOYMENT#${jobId}`, SK: "META" },
    }),
  );
  const item = out.Item as Record<string, unknown> | undefined;
  if (!item) return undefined;
  if (item.tenantId !== tenantId) return undefined;

  return {
    jobId: String(item.jobId ?? ""),
    problemId: String(item.problemId ?? ""),
    tenantId: String(item.tenantId ?? ""),
    awsAccountId: String(item.awsAccountId ?? ""),
    region: String(item.region ?? ""),
    teamName: String(item.teamName ?? ""),
    displayTeamName: typeof item.displayTeamName === "string" ? item.displayTeamName : undefined,
    namePrefix: String(item.namePrefix ?? ""),
    status: (item.status ?? "PENDING") as DeploymentStatus,
    stackId: typeof item.stackId === "string" ? item.stackId : undefined,
    stackOutputs: typeof item.stackOutputs === "string" ? item.stackOutputs : undefined,
    failureReason: typeof item.failureReason === "string" ? item.failureReason : undefined,
    createdAt: String(item.createdAt ?? ""),
    updatedAt: String(item.updatedAt ?? ""),
    expiresAt: Number(item.expiresAt ?? 0),
    eventId: typeof item.eventId === "string" ? item.eventId : undefined,
    teamId: typeof item.teamId === "string" ? item.teamId : undefined,
    teamLoginKey: undefined, // 常に undefined (= System Admin 経路では bearer 不開示)
  };
}

export interface StackProgressDeps {
  readonly cfnClient: (region: string) => CloudFormationClient;
  readonly now?: () => Date;
}

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
 * 指定 jobId の CFn StackEvents / StackResources を取得。
 *
 * application-admin-console の `getStackProgress` (= problem-deploy backend) と同型。
 * Phase 1 は same-account のみ (= Worker Lambda の execution role で CFn を引く)、
 * Phase 2 で cross-account AssumeRole に拡張する。
 */
export async function getStackProgressForTenant(
  shared: AdminInsightSharedResources,
  deps: StackProgressDeps,
  tenantId: string,
  jobId: string,
): Promise<StackProgressOutcome> {
  const got = await shared.ddb.send(
    new GetCommand({
      TableName: shared.deploymentsTableName,
      Key: { PK: `DEPLOYMENT#${jobId}`, SK: "META" },
    }),
  );
  const item = got.Item as Record<string, unknown> | undefined;
  if (!item) return { kind: "not_found" };
  if (item.tenantId !== tenantId) return { kind: "not_found" };

  const stackName = typeof item.namePrefix === "string" ? item.namePrefix : undefined;
  const region = typeof item.region === "string" ? item.region : undefined;
  if (!stackName || !region) return { kind: "stack_not_yet_created" };

  const stackId = typeof item.stackId === "string" ? item.stackId : undefined;
  const consoleUrl = buildCfnConsoleUrl(region, stackName, stackId);
  const stackRef = stackId ?? stackName;
  const cfn = deps.cfnClient(region);

  let events: StackEvent[];
  let resources: StackResource[];
  let stackStatus: string | undefined;
  try {
    const [eventsRes, resourcesRes] = await Promise.all([
      cfn.send(new DescribeStackEventsCommand({ StackName: stackRef })),
      cfn.send(new DescribeStackResourcesCommand({ StackName: stackRef })),
    ]);
    events = (eventsRes.StackEvents ?? []).slice(0, EVENTS_LIMIT);
    resources = resourcesRes.StackResources ?? [];
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
        createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined,
        events,
        stackName,
        stackStatus,
        now: deps.now?.() ?? new Date(),
      }),
    },
  };
}
