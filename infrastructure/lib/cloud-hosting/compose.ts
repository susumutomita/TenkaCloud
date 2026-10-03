import { type App, ArnFormat, Aspects, CfnOutput } from "aws-cdk-lib";
import { CfnDistribution } from "aws-cdk-lib/aws-cloudfront";
import { resolveFeatures } from "../app-config/index.js";
import { DestroyPolicySetter } from "../cdk-aspect/destroy-policy-setter.js";
import { DynamoDbLowCapacity } from "../cdk-aspect/dynamodb-low-capacity.js";
import { LogGroupRetention } from "../cdk-aspect/log-group-retention.js";
import {
  ProblemDeployBackendStack,
  type ProblemDeployBackendStackProps,
} from "../problem-deploy/problem-deploy-backend-stack.js";
import { parseTenantAdminAllowlist } from "../tenant-template/saml-admin-allowlist.js";
import { parseTenantSamlIdpConfig } from "../tenant-template/saml-identity-providers.js";
import { TenkaCloudLiteStack } from "../tenkacloud-lite/index.js";
import { cloudControlDataConfiguration, retainCloudDataTables } from "./config.js";
import { scopeInvalidationPermissions } from "./invalidation-permissions.js";
import { applyOwnershipTags } from "./ownership-tags.js";
import { cloudDeploymentTarget } from "./regions.js";
import { cloudStackLayout, cloudStackNames, cloudStackTags } from "./stack-names.js";
import { standardSynthesizer } from "./synthesizer.js";

/** Marks the restored schema and resource layout; this is not a migration marker. */
export const CLOUD_COMPOSITION = "lite-baseline-v1";

type BackendInputs = Omit<
  ProblemDeployBackendStackProps,
  | "env"
  | "synthesizer"
  | "tags"
  | "environmentName"
  | "controlDataBackend"
  | "tursoDatabaseUrl"
  | "tursoAuthTokenParameterName"
  | "retainDataTables"
  | "eventBusArn"
  | "participantPortal"
>;

/** Compose the original single-installation stacks without any SaaS provisioning stack. */
export function composeCloudHosting(app: App, env: NodeJS.ProcessEnv, inputs: BackendInputs) {
  // A single installation must not mutate the region-wide API Gateway logging account.
  app.node.setContext("@aws-cdk/aws-apigateway:disableCloudWatchRole", true);
  const environment = env.CDK_PARAM_ENVIRONMENT ?? "development";
  const names = cloudStackNames(environment, cloudStackLayout(env));
  const target = cloudDeploymentTarget(env);
  const controlData = cloudControlDataConfiguration(env);
  const retainDataTables = retainCloudDataTables(env);
  const shared = {
    env: target,
    tags: cloudStackTags(environment),
    retainDataTables,
    controlDataBackend: controlData.kind,
    ...(controlData.kind === "turso"
      ? {
          tursoDatabaseUrl: controlData.databaseUrl,
          tursoAuthTokenParameterName: controlData.authTokenParameterName,
        }
      : {}),
  };
  const backend = new ProblemDeployBackendStack(app, names.backend, {
    ...inputs,
    ...shared,
    environmentName: environment,
    synthesizer: standardSynthesizer(),
    participantPortal: { runtimeConfig: "default-dev-mock" },
  });
  const application = new TenkaCloudLiteStack(app, names.app, {
    ...shared,
    environment,
    synthesizer: standardSynthesizer(),
    deployApiLambda: backend.deployApiLambda,
    eventApiLambda: backend.eventApiLambda,
    competitorAccountsApiLambda: backend.competitorAccountsApiLambda,
    competitorBootstrapTemplateUrl: backend.competitorBootstrapTemplateUrl,
    participantPortalUrl: backend.participantPortalUrl,
    supportedProblemIds: backend.executionArtifacts?.supportedProblemIds,
    nativeProblemIds: backend.executionArtifacts?.nativeProblemIds,
    samlIdps: parseTenantSamlIdpConfig(env.TENANT_SAML_IDPS),
    samlAdminAllowlist: parseTenantAdminAllowlist(env.TENANT_SAML_ADMIN_ALLOWLIST),
    features: resolveFeatures(env),
  });
  application.addStackDependency(backend);
  for (const stack of [backend, application]) {
    stack.templateOptions.metadata = {
      TenkaCloudCloudComposition: CLOUD_COMPOSITION,
      TenkaCloudControlDataBackend: controlData.kind,
    };
    applyOwnershipTags(stack, environment);
    scopeInvalidationPermissions(
      stack,
      stack.node
        .findAll()
        .filter((node): node is CfnDistribution => node instanceof CfnDistribution)
        .map((distribution) =>
          stack.formatArn({
            service: "cloudfront",
            region: "",
            resource: "distribution",
            resourceName: distribution.ref,
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ),
    );
    new CfnOutput(stack, "CloudComposition", { value: CLOUD_COMPOSITION });
    new CfnOutput(stack, "CloudControlDataBackend", { value: controlData.kind });
    if (controlData.kind === "turso") {
      new CfnOutput(stack, "TursoDatabaseUrl", { value: controlData.databaseUrl });
      new CfnOutput(stack, "TursoAuthTokenParameterName", {
        value: controlData.authTokenParameterName,
      });
    }
    Aspects.of(stack).add(
      new DestroyPolicySetter({
        skipResourceTypes: retainDataTables ? ["AWS::DynamoDB::Table"] : [],
      }),
    );
    Aspects.of(stack).add(new DynamoDbLowCapacity(1, 1));
    Aspects.of(stack).add(new LogGroupRetention());
  }
  // The CLI resolves the pool directly; do not infer pool identity from a name prefix.
  new CfnOutput(application, "OrganizerUserPoolId", { value: application.tenantUserPoolId });
  return { backend, application };
}
