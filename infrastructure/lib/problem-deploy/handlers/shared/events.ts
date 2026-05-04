import type { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { z } from "zod";

/**
 * Deploy Backend で流れる EventBridge イベントの定義。
 *
 * Producer (Deploy API Lambda / Deploy Worker Lambda) と Consumer (Deploy Worker /
 * StatusUpdater) で同じシンボルを参照させ、文字列 drift を防ぐ。
 */

export const EVENT_SOURCE = "tenkacloud.problem" as const;
export const EVENT_DETAIL_TYPE_DEPLOY_REQUESTED = "DeployRequested" as const;
export const EVENT_DETAIL_TYPE_DEPLOY_STARTED = "DeployStarted" as const;
export const EVENT_DETAIL_TYPE_DEPLOY_FAILED = "DeployFailed" as const;
export const EVENT_DETAIL_TYPE_DEPLOY_COMPLETED = "DeployCompleted" as const;
export const EVENT_DETAIL_TYPE_DEPLOY_DELETED = "DeployDeleted" as const;

export const COMPETITOR_ROLE_NAME_DEFAULT = "TenkaCloud-CompetitorDeploy-Role" as const;

/**
 * `DeployRequested` event の `detail`。Producer (Deploy API) と Consumer (Deploy Worker)
 * の両方で参照する単一の正本。Producer は出力時、Consumer は入力時に validate する。
 *
 * `namePrefix` は `slugify` の出力 (`tc-{problemSlug}-{teamSlug}`) と一致させる。
 * 各 slug は非空かつ末尾ハイフンを許さない (UI / API の slugify と一致)。
 */
export const DeployRequestedDetailSchema = z.object({
  jobId: z.string().min(1),
  problemId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  tenantId: z.string().min(1),
  awsAccountId: z.string().regex(/^\d{12}$/),
  region: z.string().regex(/^[a-z]{2}-[a-z]+-\d+$/),
  teamName: z.string().min(1),
  namePrefix: z.string().regex(/^tc-[a-z0-9]+(?:-[a-z0-9]+)+$/),
});
export type DeployRequestedDetail = z.infer<typeof DeployRequestedDetailSchema>;

/**
 * `tenkacloud.problem` event を 1 件 publish する shared helper。
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
  await args.client.send(
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
}
