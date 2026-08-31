import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { resolveAppConfig } from "../../lib/app-config/resolve";
import { buildTenkaCloudApp } from "../../lib/app-wiring/wire";

/**
 * [#2194] The resolved source-bundle bucket name must be injected into the tenant
 * provision/deprovision ScriptJob environment (as CDK_PARAM_S3_BUCKET_NAME), so the
 * scripts read the exact bucket the deploy created instead of recomputing a
 * divergent (no-hash) name that pointed at a non-existent bucket.
 *
 * NOTE: end-to-end tenant provisioning against the real bucket runs through the
 * SBT-provisioned CodeBuild ScriptJob and needs a one-time live `make deploy-saas`
 * verification (CI does not deploy). This test pins the CDK wiring: both ScriptJob
 * CodeBuild projects carry the injected bucket name.
 */

const stubProblems = () => ({
  catalog: [],
  scoring: {},
  writeups: {},
  endpoints: {},
  phases: {},
  visibility: [],
  runtimes: {},
  disruptions: {},
  coordination: {},
  coordinationBundles: {},
});

const SOURCE_BUCKET = "tenkacloud-source-111122223333-ap-northeast-1-a4afa368";

function bootstrapTemplate(): Template {
  const config = resolveAppConfig({
    env: {
      CDK_PARAM_SYSTEM_ADMIN_EMAIL: "admin@example.com",
      CDK_PARAM_S3_BUCKET_NAME: SOURCE_BUCKET,
      CDK_SOURCE_NAME: "source.zip",
      CDK_PARAM_COMMIT_ID: "abcdef",
      CDK_PARAM_TENANT_ID: "pooled",
    },
    binDir: `${__dirname}/../../bin`,
    fs: { existsSync: () => false },
    dotenvConfig: () => undefined,
    discoverProblems: stubProblems,
  });
  const app = new cdk.App({ autoSynth: false, context: { "aws:cdk:bundling-stacks": [] } });
  buildTenkaCloudApp(app, config);
  const assembly = app.synth();
  return Template.fromJSON(assembly.getStackByName("tenkacloud-bootstrap").template);
}

describe("bootstrap-template source bucket injection (#2194)", () => {
  const template = bootstrapTemplate();

  it("should inject the resolved bucket name into a ScriptJob CodeBuild project", () => {
    template.hasResourceProperties(
      "AWS::CodeBuild::Project",
      Match.objectLike({
        Environment: Match.objectLike({
          EnvironmentVariables: Match.arrayWith([
            Match.objectLike({ Name: "CDK_PARAM_S3_BUCKET_NAME", Value: SOURCE_BUCKET }),
          ]),
        }),
      }),
    );
  });

  it("should inject it into BOTH the provision and deprovision ScriptJobs", () => {
    const projects = template.findResources("AWS::CodeBuild::Project");
    const withBucket = Object.values(projects).filter((project) => {
      const vars = project.Properties?.Environment?.EnvironmentVariables ?? [];
      return vars.some(
        (v: { Name?: string; Value?: string }) =>
          v.Name === "CDK_PARAM_S3_BUCKET_NAME" && v.Value === SOURCE_BUCKET,
      );
    });
    expect(withBucket).toHaveLength(2);
  });
});
