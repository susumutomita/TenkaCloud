import { RemovalPolicy, Stack } from "aws-cdk-lib";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

/**
 * Restore #2960's explicit deployment logs, shared by the stack's singleton provider.
 * BucketDeployment exposes logGroup; without it Lambda creates an unowned, never-expiring
 * log group at runtime that DestroyPolicySetter cannot reach. Use the same group for every
 * deployment in a stack, as the original spaDeploymentLogGroup did for its shared provider.
 *
 * S3 auto-delete providers do not expose this setting in CDK 2.262.1. Their implicit logs
 * remain outside the synthesized template and need the stack-owned CLI cleanup path.
 */
export function deploymentLogGroup(scope: Construct): LogGroup {
  const stack = Stack.of(scope);
  const id = "BucketDeploymentLogs";
  const existing = stack.node.tryFindChild(id);
  return (
    (existing as LogGroup | undefined) ??
    new LogGroup(stack, id, {
      removalPolicy: RemovalPolicy.DESTROY,
      retention: RetentionDays.ONE_DAY,
    })
  );
}
