import { Effect, PolicyDocument, PolicyStatement } from "aws-cdk-lib/aws-iam";

/**
 * #1382: least-privilege IAM for the SBT `BashJobRunner` roles that run
 * `provision-tenant.sh` / `deprovision-tenant.sh`.
 *
 * SBT's reference-arch example passes `Action:* Resource:*` to the BashJobRunner, which makes
 * each provisioning CodeBuild role an account administrator driven by EventBridge-supplied input.
 * TenkaCloud's scripts only ever:
 *   - run `bun run cdk -- deploy/destroy` — which, with the modern role-based CDK bootstrap, delegates
 *     all resource creation to the `cdk-*` bootstrap roles (job runner only needs `sts:AssumeRole`
 *     to them; the `cdk-…-cfn-exec-role` is what actually creates resources),
 *   - read the source bundle from `tenkacloud-source-<account>-<region>`,
 *   - read tenant-template stack outputs (`cloudformation:DescribeStacks`),
 *   - create/update the tenant admin user + group on the (dynamically created) tenant UserPool.
 *
 * We therefore scope the runner role to exactly that set. The SBT construct itself is unchanged —
 * only the `permissions` input is tightened. The cross-account migration (#857) shrinks it further.
 *
 * NOTE: assumes a modern (role-based) CDK bootstrap. If the account uses a legacy bootstrap, or the
 * scripts gain new direct AWS calls, this must be re-validated against a real `make deploy-saas`.
 */
export function buildTenantJobRunnerPermissions(account: string, region: string): PolicyDocument {
  return new PolicyDocument({
    statements: [
      // cdk deploy/destroy assumes the bootstrap roles; resource creation happens via cdk-cfn-exec-role.
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${account}:role/cdk-*`],
      }),
      // justify: sts:GetCallerIdentity has no resource-level scoping (AWS API design).
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["sts:GetCallerIdentity"],
        resources: ["*"],
      }),
      // CodeBuild execution logs + cdk bootstrap version (SSM) read.
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [`arn:aws:logs:${region}:${account}:*`],
      }),
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: [`arn:aws:ssm:${region}:${account}:parameter/cdk-bootstrap/*`],
      }),
      // source bundle read. The bucket is per-environment
      // (`tenkacloud-source-<account>-<region>-<envHash>`, see scripts/prepare-source-bundle.sh),
      // so grant the `tenkacloud-source-<account>-<region>*` prefix: stays scoped to this
      // account+region's source buckets while covering every environment's bucket (and the
      // legacy non-hashed name). Widening only — never removes access from the prior grant.
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket", "s3:ListBucketVersions"],
        resources: [
          `arn:aws:s3:::tenkacloud-source-${account}-${region}*`,
          `arn:aws:s3:::tenkacloud-source-${account}-${region}*/*`,
        ],
      }),
      // tenant-template stack output read.
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["cloudformation:DescribeStacks"],
        resources: [
          `arn:aws:cloudformation:${region}:${account}:stack/tenkacloud-tenant-template-*/*`,
        ],
      }),
      // tenant admin user/group management on the (dynamically created) tenant UserPool.
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminUpdateUserAttributes",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminRemoveUserFromGroup",
          "cognito-idp:AdminDeleteUser",
          "cognito-idp:CreateGroup",
          "cognito-idp:GetGroup",
          "cognito-idp:DeleteGroup",
        ],
        resources: [`arn:aws:cognito-idp:${region}:${account}:userpool/*`],
      }),
    ],
  });
}
