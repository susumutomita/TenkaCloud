import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { LocalCatalogSource } from "../../scripts/problem-pack/catalog-source.js";
import { resolveLitePackCatalog } from "../lib/app-wiring/lite-pack-catalog.js";
import { cloudCatalog } from "../lib/cloud-hosting/catalog.js";
import { composeCloudHosting } from "../lib/cloud-hosting/compose.js";
import { parseDeployAllowedCidrs } from "../lib/problem-deploy/deploy-allowed-cidrs.js";
import type { ProblemDeployBackendStackProps } from "../lib/problem-deploy/problem-deploy-backend-stack.js";

const env = process.env;
function required(name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for cloud source artifacts.`);
  return value;
}
const sourceBucketName = required("CDK_PARAM_S3_BUCKET_NAME");
const sourceObjectKey = required("CDK_SOURCE_NAME");
const pack = resolveLitePackCatalog(import.meta.dirname);
const catalogSource = pack?.catalogSource ?? new LocalCatalogSource();
const problemsRoot = resolve(import.meta.dirname, "../../problems");
const problems = cloudCatalog({
  ...catalogSource.loadBundle(problemsRoot),
  provenance: catalogSource.describeProvenance(problemsRoot),
});
const asMap = (value: unknown): Readonly<Record<string, unknown>> =>
  (value ?? {}) as Readonly<Record<string, unknown>>;
const rawLimit = env.CDK_PARAM_DEPLOY_CONCURRENT_BUILD_LIMIT?.trim();
const deployConcurrentBuildLimit = rawLimit ? Number(rawLimit) : undefined;
if (
  deployConcurrentBuildLimit !== undefined &&
  (!Number.isInteger(deployConcurrentBuildLimit) || deployConcurrentBuildLimit < 1)
) {
  throw new Error("CDK_PARAM_DEPLOY_CONCURRENT_BUILD_LIMIT must be a positive integer.");
}
const app = new App({
  // Keep CloudFormation export/import protection for persistent backend resources.
  postCliContext: { "@aws-cdk/core:defaultCrossStackReferences": "strong" },
});
composeCloudHosting(app, env, {
  sourceBucketName,
  sourceObjectKey,
  executionArtifacts: {
    legacyCatalogKey: env.CDK_LEGACY_CATALOG_KEY?.trim() || undefined,
    repositoryRoot: resolve(import.meta.dirname, "../.."),
    bundle: problems,
    packAssets: pack?.packAssets,
    sourceArchive: {
      bucket: sourceBucketName,
      key: sourceObjectKey,
      versionId: required("CDK_SOURCE_VERSION_ID"),
    },
  },
  problemsCatalog: problems.catalog as ProblemDeployBackendStackProps["problemsCatalog"],
  problemsScoring: asMap(problems.scoring),
  problemsWriteups: asMap(problems.writeups),
  problemsEndpoints: asMap(problems.endpoints),
  problemsPhases: asMap(problems.phases),
  problemsVisibility: asMap(
    problems.visibility,
  ) as ProblemDeployBackendStackProps["problemsVisibility"],
  problemRuntimes: asMap(problems.runtimes),
  problemsDisruptions: asMap(problems.disruptions),
  problemsProvenance: asMap(problems.provenance),
  problemsCoordination: asMap(problems.coordination),
  problemsCoordinationBundles: asMap(problems.coordinationBundles) as Readonly<
    Record<string, string>
  >,
  packAssets: pack?.packAssets,
  deployConcurrentBuildLimit,
  deployAllowedCidrs: parseDeployAllowedCidrs(env.CDK_PARAM_DEPLOY_ALLOWED_CIDRS),
  useBulkDistributedMap: env.CDK_PARAM_BULK_DEPLOY_VIA_DISTRIBUTED_MAP === "true",
  deployViaLambda: env.CDK_PARAM_DEPLOY_VIA_LAMBDA !== "false",
  auditLogEnabled: env.CDK_PARAM_AUDIT_LOG_ENABLED !== "false",
});
