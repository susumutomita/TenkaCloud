import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SnapshotCatalogSource } from "../lib/problem-pack/catalog-source";
import { SYNTH_TIMEOUT_MS } from "./problem-deploy-backend-stack.test-helpers";

// Issue #2220 coverage follow-up: `ParticipantPortalHosting` requires
// `apps/participant-portal/dist` to exist (CI runs tests before `make build`, so it never
// does — see `test/problem-deploy-backend-stack.test-helpers.ts`'s `synthParticipantPortalLambdaOnly`
// comment). Mock it here so we can synth the full participant portal branch without a real
// CloudFront asset while the shared coordination bundle also feeds GenericScoring.
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
    problemsCoordination: Object.fromEntries(
      Object.keys(problemsCoordinationBundles).map((problemId) => [
        problemId,
        { plugin: `coordination/${problemId}.ts` },
      ]),
    ),
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

      const pluginReaders = Object.values(
        withBundles.findResources("AWS::Lambda::Function"),
      ).filter((resource) => JSON.stringify(resource).includes("COORDINATION_PLUGIN_BUCKET"));
      // The participant dispatcher handles ops; a separate minimal-IAM Lambda drives tick().
      expect(pluginReaders).toHaveLength(2);

      const genericScoring = Object.entries(
        withBundles.findResources("AWS::Lambda::Function"),
      ).find(([logicalId]) => logicalId.includes("GenericScoringFunction"));
      expect(JSON.stringify(genericScoring?.[1])).not.toContain("COORDINATION_PLUGIN_BUCKET");

      const scoringRule = Object.values(withBundles.findResources("AWS::Events::Rule")).find(
        (resource) => JSON.stringify(resource).includes("TenkaCloud 1-min tick"),
      ) as { Properties?: { Targets?: unknown[] } } | undefined;
      expect(scoringRule?.Properties?.Targets).toHaveLength(2);
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should reach the dispatcher when a pack's coordination bundle flows through SnapshotCatalogSource (#2323)",
    async () => {
      // #2323: an installed coordination pack must no longer be inert. Compose the effective
      // bundle through the REAL SnapshotCatalogSource (empty core + one coordination pack), then
      // feed its `coordinationBundles` into the stack and assert the dispatcher subsystem
      // materializes the CoordinationPluginBundle bucket + wires the plugin bucket env.
      const coreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coord-activation-core-"));
      try {
        const bundle = new SnapshotCatalogSource({
          snapshots: [
            {
              manifest: {
                schemaVersion: 1,
                id: "com.example.coordination-pack",
                version: "1.0.0",
                core: "^1.0.0",
                title: "Coordination pack",
                description: "Declares an inter-team coordination plugin (ADR-028).",
                license: "Apache-2.0",
                problemsRoot: "problems",
                requiredRuntimes: [{ provider: "aws", engine: "cloudformation" }],
              },
              contentDigest: "c".repeat(64),
              problems: [
                {
                  problemId: "sector-control",
                  directory: "problems/battles/sector-control",
                  projections: {
                    coordination: { plugin: "coordination/sector-control.ts" },
                    coordinationBundle: "export default { reduce: (state) => state };",
                  },
                },
              ],
            },
          ],
        }).loadBundle(coreRoot);

        // The pack's synth-bundled plugin surfaced on the effective bundle (guards the seam).
        const coordinationBundles = bundle.coordinationBundles as Record<string, string>;
        expect(coordinationBundles["sector-control"]).toBeDefined();

        const withoutBundles = await synthWithParticipantPortal({});
        const withoutBundlesCount = Object.keys(
          withoutBundles.findResources("AWS::S3::Bucket"),
        ).length;

        const tpl = await synthWithParticipantPortal(coordinationBundles);

        // The pack coordination bundle adds the CoordinationPluginBundle bucket ...
        expect(Object.keys(tpl.findResources("AWS::S3::Bucket")).length).toBe(
          withoutBundlesCount + 1,
        );
        // ... and the dispatcher Lambda is wired to read it (COORDINATION_PLUGIN_BUCKET env).
        tpl.hasResourceProperties(
          "AWS::Lambda::Function",
          Match.objectLike({
            Environment: Match.objectLike({
              Variables: Match.objectLike({ COORDINATION_PLUGIN_BUCKET: Match.anyValue() }),
            }),
          }),
        );
      } finally {
        fs.rmSync(coreRoot, { recursive: true, force: true });
      }
    },
    SYNTH_TIMEOUT_MS,
  );
});
