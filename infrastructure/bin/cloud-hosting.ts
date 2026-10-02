import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { CloudApplicationStack } from "../lib/cloud-hosting/application-stack.js";
import { CloudDataStack } from "../lib/cloud-hosting/data-stack.js";
import { cloudDeploymentTarget } from "../lib/cloud-hosting/regions.js";
import { cloudStackNames, cloudStackTags } from "../lib/cloud-hosting/stack-names.js";
import { standardSynthesizer } from "../lib/cloud-hosting/synthesizer.js";
import { parseRunnerBindings } from "../lib/problem-deploy/handlers/cloud-api/execution-config.js";

const environment = process.env.CDK_PARAM_ENVIRONMENT ?? "development";
const names = cloudStackNames(environment);
const { account, region } = cloudDeploymentTarget(process.env);
const root = resolve(import.meta.dirname, "../..");
const app = new App({
  // Retain CloudFormation export/import protection for the persistent backend.
  postCliContext: { "@aws-cdk/core:defaultCrossStackReferences": "strong" },
});
const backend = new CloudDataStack(app, names.backend, {
  environment,
  env: { account, region },
  tags: cloudStackTags(environment),
  synthesizer: standardSynthesizer(),
  participantAssets: resolve(root, "apps/participant-portal/dist"),
});
const application = new CloudApplicationStack(app, names.app, {
  env: { account, region },
  tags: cloudStackTags(environment),
  synthesizer: standardSynthesizer(),
  environment,
  ...(process.env.TENKACLOUD_RUNNER_BINDINGS
    ? { runnerBindings: parseRunnerBindings(process.env.TENKACLOUD_RUNNER_BINDINGS) }
    : {}),
  backend,
  repositoryRoot: root,
  consoleAssets: resolve(root, "apps/application-admin-console/dist"),
});

application.addStackDependency(backend);
