import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SYNTH_TIMEOUT_MS } from "./problem-deploy-backend-stack.test-helpers";

// Issue #2220 coverage follow-up: `ParticipantPortalHosting` requires
// `apps/participant-portal/dist` to exist (CI runs tests before `make build`, so it never
// does — see `test/problem-deploy-backend-stack.test-helpers.ts`'s `synthParticipantPortalLambdaOnly`
// comment). Mock it here so we can synth the full `participantPortal` branch (both
// `buildParticipantPortalSubsystem` and its `coordinationPluginBucket` helper) without a real
// CloudFront asset.
const { mockDeployRuntimeConfig } = vi.hoisted(() => ({ mockDeployRuntimeConfig: vi.fn() }));

vi.mock("../lib/problem-deploy/participant-portal-hosting.js", () => ({
  ParticipantPortalHosting: class {
    distributionUrl = "https://portal.example.cloudfront.net";
    deployRuntimeConfig = mockDeployRuntimeConfig;
  },
  DEFAULT_DEV_MOCK_RUNTIME_CONFIG: (region: string) => ({
    eventTitle: "TenkaCloud Battle",
    eventRegion: region,
    mode: "dev-mock",
  }),
}));

async function synthWithParticipantPortal(
  problemsCoordinationBundles: Readonly<Record<string, string>>,
): Promise<Template> {
  const { ProblemDeployBackendStack } = await import(
    "../lib/problem-deploy/problem-deploy-backend-stack.js"
  );
  const app = new cdk.App();
  const stack = new ProblemDeployBackendStack(app, "TestStackParticipantPortal", {
    eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus",
    sourceBucketName: "test-source-bucket",
    sourceObjectKey: "source.zip",
    problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    problemsScoring: {},
    problemsEndpoints: {},
    problemsCoordinationBundles,
    environmentName: "development",
    participantPortal: { runtimeConfig: "default-dev-mock" },
  });
  return Template.fromStack(stack);
}

describe("ProblemDeployBackendStack participantPortal subsystem (#2220)", () => {
  beforeEach(() => {
    mockDeployRuntimeConfig.mockClear();
  });

  it(
    "should wire the ParticipantPortalLambda + CoordinationDispatcher + hosting when no coordination bundles are declared",
    async () => {
      const tpl = await synthWithParticipantPortal({});

      tpl.resourceCountIs("AWS::Lambda::Url", 2);
      tpl.hasOutput("ParticipantPortalApiUrl", {});
      tpl.hasOutput("CoordinationDispatcherApiUrl", {});
      tpl.hasOutput("ParticipantPortalUrl", { Value: "https://portal.example.cloudfront.net" });
      expect(mockDeployRuntimeConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "backend",
          eventTitle: "TenkaCloud Battle",
          coordinationApiUrl: expect.any(String),
        }),
      );
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should also materialize a CoordinationPluginBundle bucket when coordination bundles are declared",
    async () => {
      const withoutBundles = await synthWithParticipantPortal({});
      const withoutBundlesCount = Object.keys(
        withoutBundles.findResources("AWS::S3::Bucket"),
      ).length;

      const withBundles = await synthWithParticipantPortal({
        "hello-world": "coordination/hello-world.mjs",
      });
      const withBundlesCount = Object.keys(withBundles.findResources("AWS::S3::Bucket")).length;

      // #1420 Phase 3b: declaring a coordination bundle adds exactly one bucket
      // (CoordinationPluginBundle) over the no-bundles baseline.
      expect(withBundlesCount).toBe(withoutBundlesCount + 1);
    },
    SYNTH_TIMEOUT_MS,
  );
});
