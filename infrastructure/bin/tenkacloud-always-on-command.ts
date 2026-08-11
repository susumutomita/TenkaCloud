#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import {
  WorkerOidcCommandRoleStack,
  type WorkerOidcCommandRoleStackProps,
} from "../lib/always-on-runtime/worker-oidc-command-role-stack.js";
import { CodeBuildUseAwsManagedKms } from "../lib/cdk-aspect/codebuild-use-aws-managed-kms.js";
import { KmsKeyShortPendingWindow } from "../lib/cdk-aspect/kms-key-short-pending-window.js";

/**
 * Issue #2555 — CDK app entrypoint for the Worker OIDC
 * command seam (IAM OIDC provider + `tenkacloud-alwayson-command` role).
 *
 * Deliberately does NOT route through `resolveAppConfig`: like
 * `bin/tenkacloud-always-on-oidc.ts`, this is a one-time Always-On bootstrap
 * that only needs the target account/region plus the seam's own knobs, so it
 * reads a minimal env slice directly and fails loud when anything required is
 * absent (registering the wrong issuer or bus is exactly what must not happen
 * silently).
 *
 * App-scope Tags / Aspects mirror the other entrypoints. This stack provisions
 * no KMS / CodeBuild resources, so the aspects are inert here, but wiring them
 * keeps every entrypoint consistent.
 */

const DEFAULT_STACK_NAME = "tenkacloud-always-on-command";

/** Required env holding the Worker issuer URL (fail-loud target). */
export const ISSUER_URL_ENV = "CDK_PARAM_ALWAYS_ON_ISSUER_URL";
/** Required env holding the deploy EventBridge bus ARN (fail-loud target). */
export const EVENT_BUS_ARN_ENV = "CDK_PARAM_EVENT_BUS_ARN";

export interface BuildCommandRoleAppOptions {
  /** Environment map to read AWS account / region / seam knobs from (usually `process.env`). */
  readonly env: NodeJS.ProcessEnv;
  /** Stack construct id / name. Default `"tenkacloud-always-on-command"`. */
  readonly stackName?: string;
}

/**
 * Build the CDK App containing the single command-seam stack.
 *
 * Required env (fails loud when missing):
 *   - `CDK_PARAM_AWS_ACCOUNT_ID` (or `CDK_DEFAULT_ACCOUNT`)
 *   - `CDK_PARAM_AWS_REGION` (or `CDK_DEFAULT_REGION`)
 *   - `CDK_PARAM_ALWAYS_ON_ISSUER_URL` — the Worker's https origin (slice A serves
 *     `/.well-known/openid-configuration` + JWKS there)
 *   - `CDK_PARAM_EVENT_BUS_ARN` — the existing deploy bus ARN
 *
 * Optional env:
 *   - `CDK_PARAM_ALWAYS_ON_OIDC_PROVIDER_ARN` — import an existing IAM OIDC provider
 *   - `CDK_PARAM_ALWAYS_ON_COMMAND_SUBJECT` — override the trust-policy `sub` pattern
 *   - `CDK_PARAM_ALWAYS_ON_COMMAND_ROLE_NAME` — override the physical role name
 *   - `ENV` — environment tag value (default `development`)
 */
export function buildCommandRoleApp(options: BuildCommandRoleAppOptions): cdk.App {
  const env = options.env;

  const account = env.CDK_PARAM_AWS_ACCOUNT_ID ?? env.CDK_DEFAULT_ACCOUNT;
  const region = env.CDK_PARAM_AWS_REGION ?? env.CDK_DEFAULT_REGION;
  if (!account) {
    throw new Error(
      "tenkacloud-always-on-command: CDK_PARAM_AWS_ACCOUNT_ID (or CDK_DEFAULT_ACCOUNT) is required.",
    );
  }
  if (!region) {
    throw new Error(
      "tenkacloud-always-on-command: CDK_PARAM_AWS_REGION (or CDK_DEFAULT_REGION) is required.",
    );
  }
  const workerIssuerUrl = env[ISSUER_URL_ENV];
  if (!workerIssuerUrl) {
    throw new Error(
      `tenkacloud-always-on-command: ${ISSUER_URL_ENV} is required (the Worker origin serving the OIDC discovery document).`,
    );
  }
  const deployEventBusArn = env[EVENT_BUS_ARN_ENV];
  if (!deployEventBusArn) {
    throw new Error(
      `tenkacloud-always-on-command: ${EVENT_BUS_ARN_ENV} is required (the deploy EventBridge bus the command role may PutEvents to).`,
    );
  }

  const app = new cdk.App();

  // App-scope Tags / Aspects (shared convention with bin/tenkacloud-always-on-oidc.ts).
  cdk.Tags.of(app).add("Project", "TenkaCloud");
  cdk.Tags.of(app).add("Environment", env.ENV ?? "development");
  cdk.Aspects.of(app).add(new KmsKeyShortPendingWindow(7));
  cdk.Aspects.of(app).add(new CodeBuildUseAwsManagedKms());

  const stackProps: WorkerOidcCommandRoleStackProps = {
    env: { account, region },
    workerIssuerUrl,
    deployEventBusArn,
    ...(env.CDK_PARAM_ALWAYS_ON_OIDC_PROVIDER_ARN
      ? { existingOidcProviderArn: env.CDK_PARAM_ALWAYS_ON_OIDC_PROVIDER_ARN }
      : {}),
    ...(env.CDK_PARAM_ALWAYS_ON_COMMAND_SUBJECT
      ? { subjectClaimPattern: env.CDK_PARAM_ALWAYS_ON_COMMAND_SUBJECT }
      : {}),
    ...(env.CDK_PARAM_ALWAYS_ON_COMMAND_ROLE_NAME
      ? { commandRoleName: env.CDK_PARAM_ALWAYS_ON_COMMAND_ROLE_NAME }
      : {}),
  };

  new WorkerOidcCommandRoleStack(app, options.stackName ?? DEFAULT_STACK_NAME, stackProps);

  return app;
}

// argv entrypoint guard: only synth when executed directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildCommandRoleApp({ env: process.env }).synth();
}
