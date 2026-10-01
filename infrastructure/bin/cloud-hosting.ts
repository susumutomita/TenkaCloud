import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { CloudApplicationStack } from "../lib/cloud-hosting/application-stack.js";
import { CloudDataStack } from "../lib/cloud-hosting/data-stack.js";
import { assertCommercialRegion } from "../lib/cloud-hosting/regions.js";
import { cloudStackNames, cloudStackTags } from "../lib/cloud-hosting/stack-names.js";
import { projectSynthesizer } from "../lib/cloud-hosting/synthesizer.js";
import { parseRunnerBindings } from "../lib/problem-deploy/handlers/cloud-api/execution-config.js";

const environment = process.env.CDK_PARAM_ENVIRONMENT ?? "development";
const names = cloudStackNames(environment);
const region = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "";
const account = process.env.CDK_DEFAULT_ACCOUNT ?? process.env.ACCOUNT_ID ?? "";
assertCommercialRegion(region);
if (!/^\d{12}$/u.test(account)) throw new Error("An explicit 12-digit AWS account is required.");
const root = resolve(import.meta.dirname, "../..");
const app = new App();
const backend = new CloudDataStack(app, names.backend, {
  env: { account, region },
  tags: cloudStackTags(environment),
  synthesizer: projectSynthesizer(environment),
  participantAssets: resolve(root, "apps/participant-portal/dist"),
});
const application = new CloudApplicationStack(app, names.app, {
  env: { account, region },
  tags: cloudStackTags(environment),
  synthesizer: projectSynthesizer(environment),
  environment,
  ...(process.env.TENKACLOUD_RUNNER_BINDINGS
    ? { runnerBindings: parseRunnerBindings(process.env.TENKACLOUD_RUNNER_BINDINGS) }
    : {}),
  backend,
  repositoryRoot: root,
  consoleAssets: resolve(root, "apps/application-admin-console/dist"),
});

application.addDependency(backend);
