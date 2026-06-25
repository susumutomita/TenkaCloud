import { Stack } from "aws-cdk-lib";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

/**
 * ADR-008 Phase 3 (Issue #642): bucket 名が与えられた場合のみ S3 GetObject を
 * Lambda role に grant する。 undefined / 空なら no-op (= dormant、 最小権限維持)。
 */
export function grantChallengePayloadRead(
  scope: Construct,
  fn: IFunction,
  bucketName: string | undefined,
): void {
  if (!bucketName) return;
  const bucketArn = `arn:${Stack.of(scope).partition}:s3:::${bucketName}`;
  fn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["s3:GetObject"],
      resources: [`${bucketArn}/*`],
    }),
  );
}
