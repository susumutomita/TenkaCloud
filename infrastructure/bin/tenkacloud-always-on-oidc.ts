#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import {
  GithubOidcDeployRoleStack,
  type GithubOidcDeployRoleStackProps,
} from "../lib/always-on-runtime/github-oidc-deploy-role-stack.js";
import { CodeBuildUseAwsManagedKms } from "../lib/cdk-aspect/codebuild-use-aws-managed-kms.js";
import { KmsKeyShortPendingWindow } from "../lib/cdk-aspect/kms-key-short-pending-window.js";

/**
 * Issue #2293 — CDK app entrypoint for the GitHub Actions
 * OIDC deploy role (the Always-On runtime-lifecycle bootstrap).
 *
 * Deliberately does NOT route through `resolveAppConfig`: this is a one-time bootstrap
 * that only needs the target account/region + a couple of OIDC knobs, so it reads a
 * minimal env slice directly and fails loud when the required account/region are absent
 * (deploying an unscoped IAM trust into the wrong account is exactly what we must avoid).
 *
 * App-scope Tags / Aspects mirror the other entrypoints (`bin/tenkacloud-lite.ts` and
 * the `applyGlobalAspects` helper): cost-allocation tags + the KMS pending-window /
 * CodeBuild AWS-managed-KMS aspects. This stack provisions no KMS / CodeBuild resources,
 * so the aspects are inert here, but wiring them keeps every entrypoint consistent.
 */

const DEFAULT_STACK_NAME = "tenkacloud-always-on-oidc";

export interface BuildOidcRoleAppOptions {
  /** Environment map to read AWS account / region / OIDC knobs from (usually `process.env`). */
  readonly env: NodeJS.ProcessEnv;
  /** Stack construct id / name. Default `"tenkacloud-always-on-oidc"`. */
  readonly stackName?: string;
}

/**
 * Build the CDK App containing the single OIDC deploy-role stack.
 *
 * Required env (fails loud when missing):
 *   - `CDK_PARAM_AWS_ACCOUNT_ID` (or `CDK_DEFAULT_ACCOUNT`)
 *   - `CDK_PARAM_AWS_REGION` (or `CDK_DEFAULT_REGION`)
 *
 * Optional env:
 *   - `CDK_PARAM_GITHUB_OIDC_PROVIDER_ARN` — import an existing OIDC provider instead of creating one
 *   - `CDK_PARAM_GITHUB_OIDC_SUBJECT` — override the trust-policy `sub` claim pattern
 *   - `CDK_PARAM_GITHUB_REPOSITORY` — override the repo slug used to build the default `sub`
 *   - `CDK_PARAM_CDK_QUALIFIER` — CDK bootstrap qualifier whose roles may be assumed
 *   - `ENV` — environment tag value (default `development`)
 */
export function buildOidcRoleApp(options: BuildOidcRoleAppOptions): cdk.App {
  const env = options.env;

  const account = env.CDK_PARAM_AWS_ACCOUNT_ID ?? env.CDK_DEFAULT_ACCOUNT;
  const region = env.CDK_PARAM_AWS_REGION ?? env.CDK_DEFAULT_REGION;
  if (!account) {
    throw new Error(
      "tenkacloud-always-on-oidc: CDK_PARAM_AWS_ACCOUNT_ID (or CDK_DEFAULT_ACCOUNT) is required.",
    );
  }
  if (!region) {
    throw new Error(
      "tenkacloud-always-on-oidc: CDK_PARAM_AWS_REGION (or CDK_DEFAULT_REGION) is required.",
    );
  }

  const app = new cdk.App();

  // App-scope Tags / Aspects (shared convention with bin/tenkacloud-lite.ts).
  cdk.Tags.of(app).add("Project", "TenkaCloud");
  cdk.Tags.of(app).add("Environment", env.ENV ?? "development");
  cdk.Aspects.of(app).add(new KmsKeyShortPendingWindow(7));
  cdk.Aspects.of(app).add(new CodeBuildUseAwsManagedKms());

  const stackProps: GithubOidcDeployRoleStackProps = {
    env: { account, region },
    ...(env.CDK_PARAM_GITHUB_OIDC_PROVIDER_ARN
      ? { existingOidcProviderArn: env.CDK_PARAM_GITHUB_OIDC_PROVIDER_ARN }
      : {}),
    ...(env.CDK_PARAM_GITHUB_REPOSITORY
      ? { githubRepository: env.CDK_PARAM_GITHUB_REPOSITORY }
      : {}),
    ...(env.CDK_PARAM_GITHUB_OIDC_SUBJECT
      ? { subjectClaimPattern: env.CDK_PARAM_GITHUB_OIDC_SUBJECT }
      : {}),
    ...(env.CDK_PARAM_CDK_QUALIFIER ? { cdkQualifier: env.CDK_PARAM_CDK_QUALIFIER } : {}),
  };

  new GithubOidcDeployRoleStack(app, options.stackName ?? DEFAULT_STACK_NAME, stackProps);

  return app;
}

// argv entrypoint guard: only synth when executed directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildOidcRoleApp({ env: process.env }).synth();
}
