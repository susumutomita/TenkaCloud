import { Aspects, type IAspect, Stack } from "aws-cdk-lib";
import { CfnPolicy } from "aws-cdk-lib/aws-iam";
import type { IConstruct } from "constructs";

/** Scope CDK BucketDeployment's otherwise-wildcard invalidation grant to our distributions. */
class InvalidationPermissions implements IAspect {
  constructor(private readonly distributionArns: readonly string[]) {}
  visit(node: IConstruct): void {
    if (!(node instanceof CfnPolicy)) return;
    const document = Stack.of(node).resolve(node.policyDocument) as {
      Statement?: { Action?: unknown; Resource?: unknown }[];
    };
    if (!Array.isArray(document.Statement)) return;
    for (const [index, statement] of document.Statement.entries()) {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      const invalidationOnly =
        actions.length > 0 &&
        actions.every(
          (action: unknown) =>
            action === "cloudfront:CreateInvalidation" || action === "cloudfront:GetInvalidation",
        );
      if (statement.Resource === "*" && invalidationOnly)
        node.addPropertyOverride(`PolicyDocument.Statement.${index}.Resource`, [
          ...this.distributionArns,
        ]);
    }
  }
}
export function scopeInvalidationPermissions(
  stack: Stack,
  distributionArns: readonly string[],
): void {
  if (distributionArns.length === 0)
    throw new Error("Distribution ARNs are required for scoped invalidation.");
  Aspects.of(stack).add(new InvalidationPermissions(distributionArns));
}
