import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { EVENT_RUNTIME_STACK_ID_PREFIX } from "./event-runtime-stack.js";

/**
 * Issue #2293 — GitHub Actions OIDC runtime-lifecycle role.
 *
 * Stands up the least-privilege IAM role that the Always-On event runtime's
 * `workflow_dispatch` deploy/destroy workflows assume via OIDC
 * (`sts:AssumeRoleWithWebIdentity`) — so the runtime lifecycle carries NO long-lived
 * AWS access keys. The workflows run the per-event runtime lifecycle
 * (`make deploy-always-on-runtime` / `destroy-always-on-runtime`) under this
 * role.
 *
 * Trust hardening:
 *   - `aud` (audience) is pinned with `StringEquals` to `sts.amazonaws.com`.
 *   - `sub` (subject) is pinned with `StringLike` to
 *     `repo:susumutomita/TenkaCloud:environment:*` — environment-scoped, so a fork
 *     or any other repo cannot assume this role, and only jobs that opt into a
 *     GitHub Environment (with its protection rules) can.
 *
 * Least privilege:
 *   - CDK deploy/destroy may assume only this account's bootstrap roles.
 *   - The cleanup sweeper (manual script) may inspect CloudFormation stacks, but may delete only
 *     `tenkacloud-event-runtime-*` stacks and invoke only Lambdas whose physical name
 *     belongs to those stacks. `DescribeStacks` requires `Resource: *` when called
 *     without a stack name; no mutating wildcard grant is present.
 *
 * Like `CustomerExecutionPlaneStack` / `WorkerOidcCommandRoleStack`, this is a standalone,
 * deployable `Stack` that is intentionally NOT wired into the main `bin/infrastructure.ts`
 * app graph: the OIDC role is a one-time bootstrap that a separate entrypoint
 * (`bin/tenkacloud-always-on-oidc.ts`) deploys.
 */
export interface GithubOidcDeployRoleStackProps extends cdk.StackProps {
  /**
   * Existing GitHub OIDC provider ARN. One AWS account can hold only a single OIDC
   * provider for `token.actions.githubusercontent.com`, so when the account already
   * has one (e.g. created by `ChallengePayloadStack`), pass its ARN to import it and
   * avoid a create-time collision. When omitted, this stack creates one.
   */
  readonly existingOidcProviderArn?: string;
  /**
   * The `owner/name` slug used to build the default OIDC `sub` claim pattern.
   * Default `"susumutomita/TenkaCloud"`.
   */
  readonly githubRepository?: string;
  /**
   * The OIDC `sub` claim pattern matched with `StringLike`. Defaults to
   * `repo:<githubRepository>:environment:*` (environment-scoped). Override to widen /
   * narrow the trust (e.g. pin a single environment `:environment:always-on-runtime`).
   */
  readonly subjectClaimPattern?: string;
  /**
   * CDK bootstrap qualifier whose deploy roles this role may assume. Default
   * `"hnb659fds"` (the CDK default). Only affects the `cdk-<qualifier>-*` ARN scope.
   */
  readonly cdkQualifier?: string;
  /** Optional physical role name. When omitted CloudFormation assigns one. */
  readonly deployRoleName?: string;
}

/** CDK default bootstrap qualifier. */
const DEFAULT_CDK_QUALIFIER = "hnb659fds";
/** Default GitHub repository slug for the OIDC subject claim. */
const DEFAULT_GITHUB_REPOSITORY = "susumutomita/TenkaCloud";
/** GitHub Actions OIDC issuer host (used verbatim in the trust-policy condition keys). */
const GITHUB_OIDC_ISSUER = "token.actions.githubusercontent.com";
/** OIDC audience the trust policy pins with StringEquals. */
const OIDC_AUDIENCE = "sts.amazonaws.com";

export class GithubOidcDeployRoleStack extends cdk.Stack {
  /** ARN of the OIDC-assumable deploy role (bind to `secrets.ALWAYS_ON_DEPLOY_ROLE_ARN`). */
  public readonly deployRoleArn: string;
  /** The `sub` claim pattern the trust policy enforces (exposed for assertions). */
  public readonly subjectClaimPattern: string;

  constructor(scope: Construct, id: string, props: GithubOidcDeployRoleStackProps = {}) {
    super(scope, id, props);

    const githubRepository = props.githubRepository ?? DEFAULT_GITHUB_REPOSITORY;
    const subjectClaimPattern =
      props.subjectClaimPattern ?? `repo:${githubRepository}:environment:*`;
    const cdkQualifier = props.cdkQualifier ?? DEFAULT_CDK_QUALIFIER;
    this.subjectClaimPattern = subjectClaimPattern;

    // One account can only hold one provider for the GitHub issuer URL: import when the
    // account already has one, otherwise create it (audience `sts.amazonaws.com`).
    const oidcProvider = props.existingOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          "GithubOidc",
          props.existingOidcProviderArn,
        )
      : new iam.OpenIdConnectProvider(this, "GithubOidc", {
          url: `https://${GITHUB_OIDC_ISSUER}`,
          clientIds: [OIDC_AUDIENCE],
        });

    // Trust hardening: aud == sts.amazonaws.com AND sub LIKE the
    // environment-scoped repo pattern. Forks / other repos fail the `sub` match.
    const principal = new iam.OpenIdConnectPrincipal(oidcProvider, {
      StringEquals: {
        [`${GITHUB_OIDC_ISSUER}:aud`]: OIDC_AUDIENCE,
      },
      StringLike: {
        [`${GITHUB_OIDC_ISSUER}:sub`]: subjectClaimPattern,
      },
    });

    const role = new iam.Role(this, "DeployRole", {
      assumedBy: principal,
      ...(props.deployRoleName ? { roleName: props.deployRoleName } : {}),
      // ASCII-only (IAM Description Latin-1 gate): no arrows / em-dashes / CJK.
      description:
        "GitHub Actions OIDC role for the TenkaCloud Always-On runtime lifecycle. Repository-scoped trust.",
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // CDK lifecycle commands role-chain into the account's bootstrap roles.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        effect: iam.Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: [
          `arn:aws:iam::${this.account}:role/cdk-${cdkQualifier}-deploy-role-*`,
          `arn:aws:iam::${this.account}:role/cdk-${cdkQualifier}-file-publishing-role-*`,
          `arn:aws:iam::${this.account}:role/cdk-${cdkQualifier}-lookup-role-*`,
          `arn:aws:iam::${this.account}:role/cdk-${cdkQualifier}-cfn-exec-role-*`,
        ],
      }),
    );

    // The sweeper script uses the AWS SDK directly after assuming this role. Its read edge must
    // be account-wide because DescribeStacks has no resource-scoped list form; both
    // mutation edges remain pinned to the per-event runtime naming contract.
    // justify: cloudformation:DescribeStacks (read-only list) has no resource-scoped form when
    // called without a stack name (AWS API design) — mutations below stay ARN-pinned.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "InspectCloudFormationStacks",
        effect: iam.Effect.ALLOW,
        actions: ["cloudformation:DescribeStacks"],
        resources: ["*"],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "CleanupAlwaysOnRuntime",
        effect: iam.Effect.ALLOW,
        actions: ["cloudformation:DeleteStack"],
        resources: [
          `arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/${EVENT_RUNTIME_STACK_ID_PREFIX}-*/*`,
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeAlwaysOnRuntimeArchive",
        effect: iam.Effect.ALLOW,
        actions: ["lambda:InvokeFunction"],
        resources: [
          `arn:${this.partition}:lambda:${this.region}:${this.account}:function:${EVENT_RUNTIME_STACK_ID_PREFIX}-*`,
        ],
      }),
    );

    this.deployRoleArn = role.roleArn;

    new cdk.CfnOutput(this, "DeployRoleArnOutput", {
      value: role.roleArn,
      description: "OIDC deploy role ARN. Bind to the GitHub secret ALWAYS_ON_DEPLOY_ROLE_ARN.",
    });
    new cdk.CfnOutput(this, "SubjectClaimPatternOutput", {
      value: subjectClaimPattern,
      description: "OIDC sub claim pattern enforced by the deploy role trust policy.",
    });
  }
}
