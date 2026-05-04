import { z } from "zod";

/**
 * EventBridge から渡される detail。Producer (Deploy API Lambda) と shape を一致させる。
 * 防御的に Zod で validate する。
 */
export const DeployRequestedDetailSchema = z.object({
  jobId: z.string().min(1),
  problemId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  tenantId: z.string().min(1),
  awsAccountId: z.string().regex(/^\d{12}$/),
  region: z.string().regex(/^[a-z]{2}-[a-z]+-\d+$/),
  teamName: z.string().min(1),
  namePrefix: z.string().regex(/^tc-[a-z0-9-]+$/),
});
export type DeployRequestedDetail = z.infer<typeof DeployRequestedDetailSchema>;

export const EVENT_SOURCE = "tenkacloud.problem" as const;
export const EVENT_DETAIL_TYPE_DEPLOY_STARTED = "DeployStarted" as const;
export const EVENT_DETAIL_TYPE_DEPLOY_FAILED = "DeployFailed" as const;
