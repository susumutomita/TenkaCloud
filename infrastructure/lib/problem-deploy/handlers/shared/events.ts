import type { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { z } from "zod";

/**
 * Deploy backend で流れる EventBridge イベントの定義。
 *
 * MVP-1 (ADR-001 PR-2): tenant API Lambda が `DeployCreateRequested` を publish し、
 * EventBridge Rule が Step Functions State Machine を起動する流れ。Producer (tenant API)
 * と Consumer (State Machine input transformer) で同じシンボルを参照させ、文字列 drift
 * を防ぐ。
 *
 * `EVENT_SOURCE` は `tenkacloud.deploy` (ADR-001 命名規約)。Phase 2 で Update / Delete
 * 系イベントが増えるときも同 source を使い、detail-type で分岐する。
 */

export const EVENT_SOURCE = "tenkacloud.deploy" as const;
export const EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED = "DeployCreateRequested" as const;
export const EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED = "DeployDeleteRequested" as const;

export const COMPETITOR_ROLE_NAME_DEFAULT = "TenkaCloud-CompetitorDeploy-Role" as const;

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
  tenantId: z.string().min(1),
  problemId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  problemDir: z.string().regex(/^problems\/[a-z0-9-]+\/[a-z0-9-]+$/),
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
   * ADR-008 Phase 3 (Issue #642): private 問題用の短命 (15 分 TTL) S3 presigned URL。
   * deploy-handler が `metadata.visibility === "private"` で `CHALLENGE_PAYLOAD_BUCKET`
   * env 変数が bind されているときのみ発行する。 CodeBuild の `deploy-battles.sh`
   * がこの URL を fetch して zip 展開する (= PR-638 で実装済)。 public 問題 / 未配線
   * 環境では undefined のままで、 既存の local-path 経路で動作する。
   */
  challengePayloadUrl: z.string().url().optional(),
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
  const out = await args.client.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: args.busName,
          Source: EVENT_SOURCE,
          DetailType: args.detailType,
          Detail: JSON.stringify(args.detail),
          Resources: [`tenkacloud:deployment:${args.jobId}`],
        },
      ],
    }),
  );
  if ((out.FailedEntryCount ?? 0) === 0) return;
  const failed = out.Entries?.[0];
  throw new ProblemEventPublishError(
    args.detailType,
    args.jobId,
    failed?.ErrorCode
      ? `${failed.ErrorCode}: ${failed.ErrorMessage ?? "unknown error"}`
      : "unknown error",
  );
}
