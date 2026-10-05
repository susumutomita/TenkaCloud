import type { IAspect } from "aws-cdk-lib";
import { CfnLogGroup, LogGroup } from "aws-cdk-lib/aws-logs";
import type { IConstruct } from "constructs";
import { LAMBDA_LOG_RETENTION } from "../utils/lambda-runtime.js";

/** Set the short default only when a CFN log group has no explicit retention.
 * Implicit Lambda logs in cloud hosting are owned by OwnedRuntimeLogs.
 * No post-deploy retention script is required for that composition.
 */
export class LogGroupRetention implements IAspect {
  public visit(node: IConstruct): void {
    if (!(node instanceof CfnLogGroup) || node.retentionInDays !== undefined) return;
    // L2 defaults synthesize 731 days; omitted retention on an L2 LogGroup means
    // the caller explicitly selected INFINITE. Preserve that intent.
    if (node.node.scope instanceof LogGroup) return;
    node.retentionInDays = LAMBDA_LOG_RETENTION;
  }
}
