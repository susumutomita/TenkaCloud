#!/usr/bin/env node
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import {
  buildEventRuntimeStackId,
  EventRuntimeStack,
} from "../lib/always-on-runtime/event-runtime-stack.js";
import { CodeBuildUseAwsManagedKms } from "../lib/cdk-aspect/codebuild-use-aws-managed-kms.js";
import { DynamoDbLowCapacity } from "../lib/cdk-aspect/dynamodb-low-capacity.js";
import { KmsKeyShortPendingWindow } from "../lib/cdk-aspect/kms-key-short-pending-window.js";
import { LogGroupRetention } from "../lib/cdk-aspect/log-group-retention.js";
import {
  discoverProblemsDisruptions,
  discoverProblemsEndpoints,
  discoverProblemsPhases,
  discoverProblemsScoring,
} from "../lib/utils/discover-problems-catalog.js";

/**
 * Per-event runtime composition root.
 *
 * This app is independent of the shared OIDC command seam and creates exactly one stack keyed
 * by event id. App-scope tags/aspects and the stack-scope DynamoDB aspect mirror
 * `tenkacloud-always-on.ts` so the two Always-On composition roots do not drift as resources are
 * added in later phases.
 */

export const ALWAYS_ON_EVENT_ID_ENV = "CDK_PARAM_ALWAYS_ON_EVENT_ID";
export const ALWAYS_ON_TENANT_ID_ENV = "CDK_PARAM_ALWAYS_ON_TENANT_ID";
export const ALWAYS_ON_EXPIRES_AT_ENV = "CDK_PARAM_ALWAYS_ON_EXPIRES_AT";
export const ALWAYS_ON_DEPLOYMENTS_TABLE_ENV = "CDK_PARAM_ALWAYS_ON_DEPLOYMENTS_TABLE_NAME";
export const ALWAYS_ON_EVENTS_TABLE_ENV = "CDK_PARAM_ALWAYS_ON_EVENTS_TABLE_NAME";
export const ALWAYS_ON_ENDPOINTS_TABLE_ENV = "CDK_PARAM_ALWAYS_ON_ENDPOINTS_TABLE_NAME";
export const ALWAYS_ON_DISRUPTIONS_TABLE_ENV = "CDK_PARAM_ALWAYS_ON_DISRUPTIONS_TABLE_NAME";
export const ALWAYS_ON_EVENT_BUS_ENV = "CDK_PARAM_ALWAYS_ON_EVENT_BUS_NAME";
export const ALWAYS_ON_CONTROL_PLANE_URL_ENV = "CDK_PARAM_ALWAYS_ON_CONTROL_PLANE_URL";
export const ALWAYS_ON_RUNTIME_FEED_TOKEN_PARAMETER_ENV =
  "CDK_PARAM_ALWAYS_ON_RUNTIME_FEED_TOKEN_PARAMETER";
export const ALWAYS_ON_ARCHIVE_BUCKET_ENV = "CDK_PARAM_ALWAYS_ON_ARCHIVE_BUCKET_NAME";

export interface BuildEventRuntimeAppOptions {
  readonly env: NodeJS.ProcessEnv;
}

/** Build the CDK App containing exactly one event-specific runtime stack. */
export function buildEventRuntimeApp(options: BuildEventRuntimeAppOptions): cdk.App {
  const { env } = options;
  const app = new cdk.App();

  // Fast synth-shape checks must not bundle future runtime Lambdas.
  if (env.CDK_SKIP_BUNDLING === "1") {
    app.node.setContext("aws:cdk:bundling-stacks", []);
  }

  const environment = env.CDK_PARAM_ENVIRONMENT ?? "development";

  // App-scope tags/aspects match bin/tenkacloud-always-on.ts.
  cdk.Tags.of(app).add("Project", "TenkaCloud");
  cdk.Tags.of(app).add("Environment", environment);
  cdk.Aspects.of(app).add(
    new KmsKeyShortPendingWindow(Number(env.CDK_PARAM_KMS_PENDING_WINDOW_DAYS || 7)),
  );
  cdk.Aspects.of(app).add(new CodeBuildUseAwsManagedKms());
  cdk.Aspects.of(app).add(new LogGroupRetention());

  const eventId = requireEnv(env, ALWAYS_ON_EVENT_ID_ENV);
  const tenantId = requireEnv(env, ALWAYS_ON_TENANT_ID_ENV);
  const expiresAt = requireEnv(env, ALWAYS_ON_EXPIRES_AT_ENV);
  if (Number.isNaN(new Date(expiresAt).getTime())) {
    throw new Error(
      `${ALWAYS_ON_EXPIRES_AT_ENV} must be a valid date. ` +
        "An unparseable runtime expiry would leak past cleanup.",
    );
  }

  const stack = new EventRuntimeStack(app, buildEventRuntimeStackId(eventId), {
    ...resolveStackEnv(env),
    eventId,
    tenantId,
    expiresAt,
    scoring: buildScoringProps(env),
    archive: {
      deploymentsTableName: requireEnv(env, ALWAYS_ON_DEPLOYMENTS_TABLE_ENV),
      archiveBucketName: requireEnv(env, ALWAYS_ON_ARCHIVE_BUCKET_ENV),
    },
  });

  // Stack-scope aspect matches applyDynamoLowCapacity; it is a no-op until the runtime owns a table.
  cdk.Aspects.of(stack).add(
    new DynamoDbLowCapacity(
      Number(env.CDK_PARAM_DYNAMODB_READ_CAPACITY || 1),
      Number(env.CDK_PARAM_DYNAMODB_WRITE_CAPACITY || 1),
    ),
  );

  return app;
}

function buildScoringProps(env: NodeJS.ProcessEnv) {
  const problemsRoot = path.resolve(import.meta.dirname, "../../problems");
  const disruptionsTableName = env[ALWAYS_ON_DISRUPTIONS_TABLE_ENV]?.trim();
  const eventBusName = env[ALWAYS_ON_EVENT_BUS_ENV]?.trim();
  return {
    deploymentsTableName: requireEnv(env, ALWAYS_ON_DEPLOYMENTS_TABLE_ENV),
    eventsTableName: requireEnv(env, ALWAYS_ON_EVENTS_TABLE_ENV),
    endpointsTableName: requireEnv(env, ALWAYS_ON_ENDPOINTS_TABLE_ENV),
    ...(disruptionsTableName ? { disruptionsTableName } : {}),
    ...(eventBusName ? { eventBusName } : {}),
    runtimeFeedTokenParameterName: requireEnv(env, ALWAYS_ON_RUNTIME_FEED_TOKEN_PARAMETER_ENV),
    controlPlaneUrl: requireEnv(env, ALWAYS_ON_CONTROL_PLANE_URL_ENV),
    problemsScoring: discoverProblemsScoring(problemsRoot),
    problemsEndpoints: discoverProblemsEndpoints(problemsRoot),
    problemsPhases: discoverProblemsPhases(problemsRoot),
    problemsDisruptions: discoverProblemsDisruptions(problemsRoot),
  };
}

/** Make the stack environment-aware only when account and region are both configured. */
function resolveStackEnv(env: NodeJS.ProcessEnv): { env?: { account: string; region: string } } {
  const account = env.CDK_PARAM_AWS_ACCOUNT_ID ?? env.CDK_DEFAULT_ACCOUNT ?? "";
  const region = env.CDK_PARAM_AWS_REGION ?? env.CDK_DEFAULT_REGION ?? "";
  return account && region ? { env: { account, region } } : {};
}

/** Read a required lifecycle input and fail loudly when it is absent or blank. */
function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required to deploy an always-on event runtime.`);
  }
  return value;
}

// Thin entrypoint shim: build only when executed as the CDK app, never when imported by Vitest.
// import.meta.main is undefined under Node 22 / tsx, so compare the resolved argv path instead.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  buildEventRuntimeApp({ env: process.env });
}
