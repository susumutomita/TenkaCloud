import type { DeploymentStatus } from "../shared/cfn-status.js";

/**
 * StatusUpdater が DDB から拾う行の必要フィールド。`DeploymentItem` のサブセット。
 */
export interface TrackedDeployment {
  jobId: string;
  tenantId: string;
  problemId: string;
  awsAccountId: string;
  region: string;
  namePrefix: string;
  stackId?: string;
  status: DeploymentStatus;
  expiresAt: number;
}
