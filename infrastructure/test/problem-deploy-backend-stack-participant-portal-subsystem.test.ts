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
  opts: {
    deployViaLambda?: boolean;
    controlDataBackend?: string;
    tursoDatabaseUrl?: string;
    tursoAuthTokenParameterName?: string;
  } = {},
): Promise<Template> {
  const { ProblemDeployBackendStack } = await import(
    "../lib/problem-deploy/problem-deploy-backend-stack.js"
  );
  const app = new cdk.App({ autoSynth: false });
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
    // #2291: flag OFF (default) では CfnDeploy / job log group を生成しない。
    ...(opts.deployViaLambda ? { deployViaLambda: true } : {}),
    // Issue #2440: control-plane data backend (turso wiring pin).
    ...(opts.controlDataBackend ? { controlDataBackend: opts.controlDataBackend } : {}),
    ...(opts.tursoDatabaseUrl ? { tursoDatabaseUrl: opts.tursoDatabaseUrl } : {}),
    ...(opts.tursoAuthTokenParameterName
      ? { tursoAuthTokenParameterName: opts.tursoAuthTokenParameterName }
      : {}),
  });
  return Template.fromStack(stack);
}

/** Return the participant portal Lambda's env Variables from a synthesized template. */
function participantPortalEnv(tpl: Template): Record<string, unknown> {
  const functions = tpl.findResources("AWS::Lambda::Function");
  const portal = Object.entries(functions).find(
    ([name]) => name.includes("ParticipantPortal") && name.includes("Function"),
  );
  return (
    (portal?.[1] as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
      ?.Properties?.Environment?.Variables ?? {}
  );
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
                description: "Declares an inter-team coordination plugin.",
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

  it(
    "should wire the scoring-driven coordination tick: GenericScoring gains lambda:InvokeFunction on the dispatcher + its function name env, and no S3 (#2324)",
    async () => {
      const tpl = await synthWithParticipantPortal({});
      const fns = tpl.findResources("AWS::Lambda::Function");
      const scoring = Object.entries(fns).find(
        ([name]) => name.includes("GenericScoring") && name.includes("Function"),
      );
      expect(scoring).toBeDefined();

      // (a) 採点 Lambda は dispatcher の function name を env で受け取り、 tick batch を Invoke する。
      const env =
        (
          scoring?.[1] as {
            Properties?: { Environment?: { Variables?: Record<string, unknown> } };
          }
        )?.Properties?.Environment?.Variables ?? {};
      expect(env.COORDINATION_DISPATCHER_FUNCTION_NAME).toBeDefined();

      // (b) 採点 role が coordination のために得る IAM は `lambda:InvokeFunction` のみ (= dispatcher へ
      // 委譲するためだけ)。 plugin bundle を読むための `s3:*` は付与しない (= plugin は dispatcher 内でのみ
      // load するため、採点 role と dispatcher の資格情報を分離する)。
      const policies = tpl.findResources("AWS::IAM::Policy");
      const scoringPolicies = Object.entries(policies).filter(([name]) =>
        name.includes("GenericScoring"),
      );
      const scoringActions = scoringPolicies.flatMap(([, p]) =>
        (
          (
            p as {
              Properties?: { PolicyDocument?: { Statement?: Array<{ Action?: unknown }> } };
            }
          ).Properties?.PolicyDocument?.Statement ?? []
        ).flatMap((s) => ([] as unknown[]).concat(s.Action ?? [])),
      );
      expect(scoringActions).toContain("lambda:InvokeFunction");
      expect(scoringActions.some((a) => typeof a === "string" && a.startsWith("s3:"))).toBe(false);
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should NOT wire DEPLOY_JOB_LOG_GROUP into the participant portal when deployViaLambda is OFF (default, #2291 no regression)",
    async () => {
      const tpl = await synthWithParticipantPortal({});
      expect(participantPortalEnv(tpl).DEPLOY_JOB_LOG_GROUP).toBeUndefined();

      // No DeployJobLogsRead grant on the default (CodeBuild) path.
      const roles = tpl.findResources("AWS::IAM::Role");
      const hasGrant = Object.values(roles).some((r) =>
        (
          (r as { Properties?: { Policies?: Array<{ PolicyName?: string }> } }).Properties
            ?.Policies ?? []
        ).some((p) => p.PolicyName === "DeployJobLogsRead"),
      );
      expect(hasGrant).toBe(false);
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should wire the job log group into the participant portal when deployViaLambda is ON (#2291)",
    async () => {
      const tpl = await synthWithParticipantPortal({}, { deployViaLambda: true });

      // (a) the dedicated job-progress log group exists (RetentionDays.ONE_MONTH = 30).
      tpl.hasResourceProperties("AWS::Logs::LogGroup", Match.objectLike({ RetentionInDays: 30 }));

      // (b) the CfnDeploy function gains DEPLOY_JOB_LOG_GROUP + a scoped write grant.
      tpl.hasResourceProperties(
        "AWS::IAM::Policy",
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                Effect: "Allow",
              }),
            ]),
          }),
        }),
      );

      // (c) the participant portal function gains DEPLOY_JOB_LOG_GROUP + a scoped read grant.
      expect(participantPortalEnv(tpl).DEPLOY_JOB_LOG_GROUP).toBeDefined();
      const roles = tpl.findResources("AWS::IAM::Role");
      const hasReadGrant = Object.values(roles).some((r) =>
        (
          (r as { Properties?: { Policies?: Array<{ PolicyName?: string }> } }).Properties
            ?.Policies ?? []
        ).some((p) => p.PolicyName === "DeployJobLogsRead"),
      );
      expect(hasReadGrant).toBe(true);
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should keep the CoordinationDispatcher role minimal-IAM (no sts/ssm/kms), unchanged by the tick (#2324)",
    async () => {
      const tpl = await synthWithParticipantPortal({});
      // dispatcher の IAM は明示 Role の inline policy (= `AWS::IAM::Role` の Properties.Policies)。
      const roles = tpl.findResources("AWS::IAM::Role");
      const dispatcherRole = Object.entries(roles).find(([name]) =>
        name.includes("CoordinationDispatcher"),
      );
      expect(dispatcherRole).toBeDefined();
      const [, dispatcherResource] = dispatcherRole as [
        string,
        {
          Properties?: {
            Policies?: Array<{ PolicyDocument?: { Statement?: Array<{ Action?: unknown }> } }>;
          };
        },
      ];
      const inlinePolicies = dispatcherResource.Properties?.Policies ?? [];
      const dispatcherActions = inlinePolicies
        .flatMap((pol) =>
          (pol.PolicyDocument?.Statement ?? []).flatMap((s) =>
            ([] as unknown[]).concat(s.Action ?? []),
          ),
        )
        .filter((a): a is string => typeof a === "string");
      // op 経路と同じ最小 IAM を維持: coordination row の DDB Query/Get/Put のみ。 tick を本 Lambda 内で
      // 走らせても、競技者資格情報に到達しうる sts/ssm/kms は付与されない。
      expect(dispatcherActions).toContain("dynamodb:PutItem");
      expect(dispatcherActions.some((a) => a.startsWith("sts:"))).toBe(false);
      expect(dispatcherActions.some((a) => a.startsWith("ssm:"))).toBe(false);
      expect(dispatcherActions.some((a) => a.startsWith("kms:"))).toBe(false);
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should wire CONTROL_DATA_BACKEND + Turso env/IAM into ParticipantPortalLambda when turso is selected, leaving CoordinationDispatcher untouched (#2440)",
    async () => {
      const tpl = await synthWithParticipantPortal(
        {},
        {
          controlDataBackend: "turso",
          tursoDatabaseUrl: "libsql://example.turso.io",
          tursoAuthTokenParameterName: "/tenkacloud/development/turso-token",
        },
      );
      const env = participantPortalEnv(tpl);
      expect(env.CONTROL_DATA_BACKEND).toBe("turso");
      expect(env.TURSO_DATABASE_URL).toBe("libsql://example.turso.io");
      expect(env.TURSO_AUTH_TOKEN_PARAMETER_NAME).toBe("/tenkacloud/development/turso-token");
      expect(JSON.stringify(tpl.toJSON())).toContain(
        ":parameter/tenkacloud/development/turso-token",
      );

      // the dispatcher must not gain sts/ssm/kms just because the portal did.
      const roles = tpl.findResources("AWS::IAM::Role");
      const dispatcherRole = Object.entries(roles).find(([name]) =>
        name.includes("CoordinationDispatcher"),
      );
      const dispatcherActions = (
        (
          dispatcherRole?.[1] as {
            Properties?: {
              Policies?: Array<{ PolicyDocument?: { Statement?: Array<{ Action?: unknown }> } }>;
            };
          }
        )?.Properties?.Policies ?? []
      ).flatMap((pol) =>
        (pol.PolicyDocument?.Statement ?? []).flatMap((s) =>
          ([] as unknown[]).concat(s.Action ?? []),
        ),
      );
      expect(dispatcherActions.some((a) => typeof a === "string" && a.startsWith("ssm:"))).toBe(
        false,
      );
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should omit EVENTS_TABLE_NAME env + the EventsRead policy from ParticipantPortalLambda when the pure SQL backend is selected (#2440)",
    async () => {
      const tpl = await synthWithParticipantPortal(
        {},
        {
          controlDataBackend: "turso",
          tursoDatabaseUrl: "libsql://example.turso.io",
          tursoAuthTokenParameterName: "/tenkacloud/development/turso-token",
        },
      );
      expect(participantPortalEnv(tpl).EVENTS_TABLE_NAME).toBeUndefined();

      const roles = tpl.findResources("AWS::IAM::Role");
      const portalRole = Object.entries(roles).find(([name]) =>
        name.includes("ParticipantPortalLambda"),
      );
      expect(portalRole).toBeDefined();
      const policyNames = (
        (portalRole?.[1] as { Properties?: { Policies?: Array<{ PolicyName?: string }> } })
          ?.Properties?.Policies ?? []
      ).map((p) => p.PolicyName);
      expect(policyNames).not.toContain("EventsRead");

      // No AWS::DynamoDB::Table logical id starting with Events/Teams (pure SQL: no table synth).
      const tableIds = Object.keys(tpl.findResources("AWS::DynamoDB::Table"));
      expect(tableIds.some((id) => id.startsWith("Events"))).toBe(false);
      expect(tableIds.some((id) => id.startsWith("Teams"))).toBe(false);
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should omit PROBLEM_ENDPOINTS_TABLE_NAME env + the EndpointsRW policy + the ProblemEndpoints table when the pure SQL backend is selected (#2442 Phase C1)",
    async () => {
      const tpl = await synthWithParticipantPortal(
        {},
        {
          controlDataBackend: "turso",
          tursoDatabaseUrl: "libsql://example.turso.io",
          tursoAuthTokenParameterName: "/tenkacloud/development/turso-token",
        },
      );
      expect(participantPortalEnv(tpl).PROBLEM_ENDPOINTS_TABLE_NAME).toBeUndefined();

      const roles = tpl.findResources("AWS::IAM::Role");
      const portalRole = Object.entries(roles).find(([name]) =>
        name.includes("ParticipantPortalLambda"),
      );
      expect(portalRole).toBeDefined();
      const policyNames = (
        (portalRole?.[1] as { Properties?: { Policies?: Array<{ PolicyName?: string }> } })
          ?.Properties?.Policies ?? []
      ).map((p) => p.PolicyName);
      expect(policyNames).not.toContain("EndpointsRW");

      // No AWS::DynamoDB::Table logical id starting with ProblemEndpoints (pure SQL: no table synth).
      const tableIds = Object.keys(tpl.findResources("AWS::DynamoDB::Table"));
      expect(tableIds.some((id) => id.startsWith("ProblemEndpoints"))).toBe(false);
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should keep PROBLEM_ENDPOINTS_TABLE_NAME env + the EndpointsRW policy for the default dynamodb backend (byte-compat)",
    async () => {
      const tpl = await synthWithParticipantPortal({});
      expect(participantPortalEnv(tpl).PROBLEM_ENDPOINTS_TABLE_NAME).toBeDefined();

      const roles = tpl.findResources("AWS::IAM::Role");
      const portalRole = Object.entries(roles).find(([name]) =>
        name.includes("ParticipantPortalLambda"),
      );
      const policyNames = (
        (portalRole?.[1] as { Properties?: { Policies?: Array<{ PolicyName?: string }> } })
          ?.Properties?.Policies ?? []
      ).map((p) => p.PolicyName);
      expect(policyNames).toContain("EndpointsRW");
    },
    SYNTH_TIMEOUT_MS,
  );
});
