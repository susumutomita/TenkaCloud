import { Effect, PolicyDocument, PolicyStatement } from "aws-cdk-lib/aws-iam";

/** Build an IAM PolicyDocument with multiple statements. */
export function buildMultiPolicy(
  ...statements: { actions: string[]; resources: string[] }[]
): PolicyDocument {
  return new PolicyDocument({
    statements: statements.map(
      (s) =>
        new PolicyStatement({
          actions: s.actions,
          resources: s.resources,
          effect: Effect.ALLOW,
        }),
    ),
  });
}
