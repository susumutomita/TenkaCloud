import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { handle, type LambdaContext, type LambdaEvent } from "hono/aws-lambda";
import { acquireCloudData } from "../../control-data/cloud-data.js";
import type { CloudData } from "../../control-data/cloud-data-ports.js";
import { createAwsCloudRunnerDependencies } from "../cloud-runner/sdk.js";
import { createInstallationExternalIdStore } from "../shared/external-id-store.js";
import { createCloudApp } from "./app.js";
import { createRegisteredConnectionPreparer } from "./connection-routes.js";
import {
  createConnectionVerifier,
  createExecutionArtifactResolver,
  createExecutionCatalogProvider,
  createJobBindingAuthorizer,
  installationAccountConfig,
  loadExecutionBindings,
  registeredRunnerBinding,
} from "./execution-config.js";
import { createProductionNativeCoordination } from "./native-production.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing cloud setting: ${name}`);
  return value;
}
async function compose() {
  const data = await acquireCloudData();
  const execution = await composeExecution(data);
  return createCloudApp({
    repository: data.repository,
    ...execution,
    organizerAuth: { issuer: required("COGNITO_ISSUER"), audience: required("COGNITO_CLIENT_ID") },
    allowedOrigins: required("ALLOWED_ORIGINS").split(","),
  });
}
async function composeExecution(data: CloudData) {
  const { repository, work, accounts } = data;
  if (!process.env.CLOUD_CATALOG_KEY) return {};
  const coordination = createProductionNativeCoordination({
    repository,
    store: data.coordination,
    artifactBucket: required("CLOUD_ARTIFACT_BUCKET"),
    expectedBucketOwner: required("CONTROL_PLANE_ACCOUNT"),
    region: required("AWS_REGION"),
    catalogKey: required("CLOUD_CATALOG_KEY"),
  });
  const bindings = await loadExecutionBindings();
  const catalog = createExecutionCatalogProvider();
  const controlPlaneAccount = required("CONTROL_PLANE_ACCOUNT");
  const verify = createConnectionVerifier(controlPlaneAccount);
  const config = process.env.COMPETITOR_ROLE_NAME ? installationAccountConfig() : undefined;
  const participantAccess = {
    work,
    controlPlaneAccount,
    runner: createAwsCloudRunnerDependencies({ controlPlaneRegion: required("AWS_REGION") }),
    sts: new STSClient({ region: required("AWS_REGION"), ignoreConfiguredEndpointUrls: true }),
    authorizeJob: createJobBindingAuthorizer({ bindings, accounts, config, controlPlaneAccount }),
    resolveArtifacts: createExecutionArtifactResolver(),
  };
  if (!config)
    return {
      coordination,
      deployment: { work, catalog, controlPlaneAccount: required("CONTROL_PLANE_ACCOUNT") },
      connections: { bindings, verify },
      participantAccess,
    };
  const externalIds = createInstallationExternalIdStore({
    ssm: new SSMClient({ region: required("AWS_REGION"), ignoreConfiguredEndpointUrls: true }),
    parameterArn: config.externalIdParameterArn,
    reserveInitialization: () =>
      accounts.reserveExternalIdInitialization(config.externalIdParameterArn),
    recordUse: () => accounts.observeExternalId(config.externalIdParameterArn),
  });
  return {
    coordination,
    participantAccess,
    deployment: {
      work,
      catalog,
      controlPlaneAccount: required("CONTROL_PLANE_ACCOUNT"),
      prepareConnection: createRegisteredConnectionPreparer({
        accounts,
        work,
        config,
        catalog,
        legacyBindings: bindings,
      }),
    },
    connections: { bindings, verify },
    accounts: {
      accounts,
      assertAccepting: () => repository.assertAcceptingInstallation(),
      tenkaCloudAccountId: required("CONTROL_PLANE_ACCOUNT"),
      competitorRoleName: config.roleName,
      defaultRegion: required("AWS_REGION"),
      ensureExternalId: externalIds.ensure,
      verify: async (
        record: import("../../control-data/domain/competitor-accounts.js").CompetitorAccountRecord,
      ) => {
        await externalIds.ensure();
        // Verifying an unverified registration checks its immutable scope, not a pre-existing verified flag.
        await verify(
          registeredRunnerBinding(
            { ...record, verified: true },
            config,
            Object.keys(await catalog()),
          ),
        );
      },
    },
  };
}
let application: ReturnType<typeof compose> | undefined;
export async function handler(event: LambdaEvent, context: LambdaContext) {
  application ??= compose().catch((error: unknown) => {
    application = undefined;
    throw error;
  });
  return handle(await application)(event, context);
}
