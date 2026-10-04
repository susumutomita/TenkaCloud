import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { App, Aspects, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProblemsCatalogBundle } from "../../../scripts/problem-pack/catalog-types.js";
import { DestroyPolicySetter } from "../../lib/cdk-aspect/destroy-policy-setter.js";
import { composeCloudHosting } from "../../lib/cloud-hosting/compose.js";
import {
  buildCloudExecutionArtifacts,
  CloudExecutionArtifacts,
} from "../../lib/cloud-hosting/execution-artifacts.js";
import {
  contentDigest,
  createCatalogLoader,
  createExecutionObjectLoader,
  loadSavedCatalog,
  MAX_EXECUTION_PLUGIN_BYTES,
} from "../../lib/problem-deploy/handlers/shared/execution-catalog.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "execution-pin-test-"));
  roots.push(root);
  const directory = "problems/challenges/fixture";
  mkdirSync(join(root, directory, "runtime"), { recursive: true });
  writeFileSync(
    join(root, directory, "metadata.json"),
    JSON.stringify({ hints: [{ id: "hint", text: "A", penalty: 3 }] }),
  );
  writeFileSync(join(root, directory, "template.yaml"), "Resources: A");
  writeFileSync(join(root, directory, "runtime/main.tf"), "resource A");
  const bundle: ProblemsCatalogBundle = {
    catalog: { fixture: directory },
    scoring: { fixture: { kind: "flag", points: 5 } },
    endpoints: { fixture: [{ id: "A" }] },
    phases: { fixture: ["A"] },
    visibility: { fixture: "private" },
    runtimes: { fixture: { provider: "aws", engine: "cloudformation" } },
    disruptions: { fixture: ["A"] },
    writeups: { fixture: { ja: "A", en: "A" } },
    provenance: { fixture: { source: "core" } },
    coordination: { fixture: { plugin: "plugin.ts" } },
    coordinationBundles: { fixture: "export default { version: 'A' };" },
  };
  return {
    repositoryRoot: root,
    bundle,
    sourceArchive: { bucket: "source", key: "source.zip", versionId: "version-A" },
    directory,
  };
}
function memoryClient(objects: Map<string, Uint8Array>) {
  const send = vi.fn(async (command: GetObjectCommand) => {
    const body = objects.get(command.input.Key ?? "");
    if (!body) throw new Error("NoSuchKey");
    return {
      ContentLength: body.byteLength,
      Body: {
        transformToWebStream: () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(body);
              controller.close();
            },
          }),
      },
    };
  });
  return { send, client: { send } as unknown as Pick<S3Client, "send"> };
}

describe("immutable cloud execution artifacts", () => {
  it("keeps A metadata, private template/runtime bytes, and plugin after B or catalog removal", async () => {
    const input = fixture();
    const a = buildCloudExecutionArtifacts(input);
    writeFileSync(join(input.repositoryRoot, input.directory, "template.yaml"), "Resources: B");
    writeFileSync(join(input.repositoryRoot, input.directory, "runtime/main.tf"), "resource B");
    const b = buildCloudExecutionArtifacts({
      ...input,
      bundle: {
        ...input.bundle,
        scoring: { fixture: { points: 99 } },
        coordinationBundles: { fixture: "export default { version: 'B' };" },
      },
      sourceArchive: { ...input.sourceArchive, versionId: "version-B" },
    });
    const removed = buildCloudExecutionArtifacts({
      ...input,
      bundle: {
        catalog: {},
        scoring: {},
        endpoints: {},
        phases: {},
        visibility: {},
        runtimes: {},
        disruptions: {},
        coordination: {},
        coordinationBundles: {},
      },
    });
    const objects = new Map([...a.objects, ...b.objects, ...removed.objects]);
    const memory = memoryClient(objects);
    const config = {
      artifactBucket: "private-artifacts",
      expectedBucketOwner: "123456789012",
      s3: memory.client,
    };
    const load = createCatalogLoader(config);
    const raw = createExecutionObjectLoader(config);
    const saved = await load(a.catalogKey);
    expect(saved.catalogKey).not.toBe(b.catalogKey);
    expect(saved.scoring.fixture).toEqual({ kind: "flag", points: 5 });
    expect(saved.hints.fixture).toEqual([{ id: "hint", text: "A", penalty: 3 }]);
    expect(saved.sourceArchive.versionId).toBe("version-A");
    expect(saved.visibility.fixture).toBe("private");
    expect(
      Buffer.from(await raw(saved.sources.fixture?.["template.yaml"]?.key ?? "missing")).toString(),
    ).toBe("Resources: A");
    expect(
      Buffer.from(
        await raw(saved.sources.fixture?.["runtime/main.tf"]?.key ?? "missing"),
      ).toString(),
    ).toBe("resource A");
    expect(Buffer.from(await raw(saved.plugins.fixture?.key ?? "missing")).toString()).toContain(
      "'A'",
    );
    expect((await load(removed.catalogKey)).catalog).toEqual({});
    saved.scoring.fixture = { points: 777 };
    expect((await load(a.catalogKey)).scoring.fixture).toEqual({ kind: "flag", points: 5 });
    expect(memory.send.mock.calls[0]?.[0].input).toMatchObject({
      Bucket: "private-artifacts",
      ExpectedBucketOwner: "123456789012",
    });
  });

  it("never substitutes current catalog B for an unpinned legacy record", () => {
    vi.stubEnv("CLOUD_CATALOG_KEY", `catalogs/${"b".repeat(64)}.json`);
    vi.stubEnv("CLOUD_LEGACY_CATALOG_KEY", "");
    expect(() => loadSavedCatalog(undefined)).toThrow("execution_catalog_unpinned");
    vi.stubEnv("CLOUD_LEGACY_CATALOG_KEY", "malformed");
    expect(() => loadSavedCatalog(undefined)).toThrow();
  });

  it("marks only the reviewed core pure battle native and retains the optional AWS variant", () => {
    const problemId = "ac26-crypto-battle";
    const directory = "problems/battles/ac26-crypto-battle";
    const base = fixture();
    const bundle = {
      ...base.bundle,
      catalog: { [problemId]: directory },
      coordination: { [problemId]: { plugin: "coordination/crypto-battle.ts" } },
      coordinationBundles: {},
    };
    const native = buildCloudExecutionArtifacts({
      ...base,
      repositoryRoot: resolve(import.meta.dirname, "../../.."),
      bundle,
    });
    const descriptor = native.catalog.nativeProblems?.[0];
    expect(descriptor).toMatchObject({
      problemId,
      problemDir: directory,
      kind: "coordination",
      stateBudget: { bytesPerTeam: 31744, baseBytes: 1536 },
    });
    expect(native.catalog.plugins[problemId]).toEqual({
      key: descriptor?.pluginKey,
      digest: descriptor?.artifactDigest,
    });
    expect(base.bundle.coordination).toHaveProperty("fixture");
    expect(buildCloudExecutionArtifacts(base).catalog.nativeProblems).toBeUndefined();

    mkdirSync(join(base.repositoryRoot, directory), { recursive: true });
    writeFileSync(
      join(base.repositoryRoot, directory, "metadata.json"),
      JSON.stringify({ cfnParameters: { ScoreStealEnabled: "true" } }),
    );
    writeFileSync(
      join(base.repositoryRoot, directory, "template.yaml"),
      "AWS score steal resources",
    );
    const aws = buildCloudExecutionArtifacts({ ...base, bundle });
    expect(aws.catalog.nativeProblems).toBeUndefined();
    const sourceKey = aws.catalog.sources[problemId]?.["template.yaml"]?.key;
    expect(sourceKey ? Buffer.from(aws.objects.get(sourceKey) ?? []).toString() : undefined).toBe(
      "AWS score steal resources",
    );
  });

  it("evicts failed loads, rejects corruption, and never fetches malformed identities", async () => {
    const a = buildCloudExecutionArtifacts(fixture());
    const memory = memoryClient(new Map());
    const load = createCatalogLoader({ artifactBucket: "artifacts", s3: memory.client });
    await expect(load(a.catalogKey)).rejects.toThrow("NoSuchKey");
    memory.send.mockImplementation(async () => ({
      ContentLength: 3,
      Body: {
        transformToWebStream: () =>
          new ReadableStream({
            start(c) {
              c.enqueue(Buffer.from("bad"));
              c.close();
            },
          }),
      },
    }));
    await expect(load(a.catalogKey)).rejects.toThrow("integrity mismatch");
    const good = memoryClient(a.objects);
    memory.send.mockImplementation(good.send);
    await expect(load(a.catalogKey)).resolves.toMatchObject({ catalogKey: a.catalogKey });
    const calls = memory.send.mock.calls.length;
    await expect(load("catalogs/../../secrets")).rejects.toThrow();
    expect(memory.send).toHaveBeenCalledTimes(calls);
  });

  it("bounds bytes while streaming even when ContentLength lies", async () => {
    const key = `plugins/${contentDigest("x")}.mjs`;
    const memory = memoryClient(new Map([[key, new Uint8Array(MAX_EXECUTION_PLUGIN_BYTES + 1)]]));
    memory.send.mockImplementation(async () => ({
      ContentLength: 1,
      Body: {
        transformToWebStream: () =>
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(MAX_EXECUTION_PLUGIN_BYTES + 1));
              c.close();
            },
          }),
      },
    }));
    const load = createExecutionObjectLoader({ artifactBucket: "artifacts", s3: memory.client });
    await expect(load(key)).rejects.toThrow("byte limit");
  });

  it("rejects source symlinks instead of publishing their bytes", () => {
    const input = fixture();
    symlinkSync(
      join(input.repositoryRoot, input.directory, "metadata.json"),
      join(input.repositoryRoot, input.directory, "link.json"),
    );
    expect(() => buildCloudExecutionArtifacts(input)).toThrow("symbolic links");
  });

  it.each(["dynamodb", "turso"])(
    "wires saved readers and source grants with the existing %s tables",
    (provider) => {
      const input = fixture();
      const legacyCatalogKey = `catalogs/${"a".repeat(64)}.json`;
      const app = new App();
      const { backend, application } = composeCloudHosting(
        app,
        {
          ACCOUNT_ID: "123456789012",
          REGION: "us-east-1",
          CDK_PARAM_ENVIRONMENT: "pins",
          ...(provider === "turso"
            ? {
                CDK_PARAM_CONTROL_DATA_BACKEND: "turso",
                CDK_PARAM_TURSO_DATABASE_URL: "libsql://fixture.turso.io",
                CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME: "/TenkaCloud/pins/token",
              }
            : {}),
        },
        {
          sourceBucketName: input.sourceArchive.bucket,
          sourceObjectKey: input.sourceArchive.key,
          executionArtifacts: {
            ...input,
            legacyCatalogKey,
            bundle: { ...input.bundle, coordination: {}, coordinationBundles: {} },
          },
          problemsCatalog: { fixture: input.directory },
          problemsScoring: {},
          problemsEndpoints: {},
          deployViaLambda: true,
        },
      );
      const appTemplate = Template.fromStack(application).toJSON();
      const runtimeDeployment =
        appTemplate.Resources
          .ApplicationAdminConsoleHostingRuntimeConfigDeploymentCustomResource177335E6;
      const runtimeSource = runtimeDeployment.Properties.SourceObjectKeys[0] as string;
      let runtimeJson = readFileSync(
        join(app.outdir, `asset.${runtimeSource.replace(/\.zip$/u, "")}`, "runtime-config.json"),
        "utf8",
      );
      for (const token of Object.keys(runtimeDeployment.Properties.SourceMarkers[0]))
        runtimeJson = runtimeJson.replaceAll(token, JSON.stringify("synthetic-cfn-token"));
      const runtimeConfig = JSON.parse(runtimeJson);
      expect(runtimeConfig).toMatchObject({
        supportedProblemIds: ["fixture"],
        nativeProblemIds: [],
      });
      expect(runtimeConfig).not.toHaveProperty("mode");
      const template = Template.fromStack(backend);
      template.resourceCountIs("AWS::DynamoDB::Table", provider === "turso" ? 0 : 7);
      const readers = Object.entries(template.findResources("AWS::Lambda::Function"));
      for (const prefix of [
        "DeployApiFunction",
        "EventApiFunction",
        "ParticipantPortalLambdaFunction",
        "GenericScoringFunction",
        "CfnDeployFunction",
        "CoordinationDispatcherFunction",
        "DisruptionExecutorFunction",
      ]) {
        const resource = readers.find(([id]) => id.startsWith(prefix))?.[1];
        expect(resource, prefix).toBeDefined();
        expect(resource?.Properties.Environment.Variables).toMatchObject({
          CLOUD_CATALOG_KEY: backend.executionArtifacts?.catalogKey,
          CLOUD_LEGACY_CATALOG_KEY: legacyCatalogKey,
          CONTROL_PLANE_ACCOUNT: "123456789012",
        });
      }
      const buckets = Object.keys(template.findResources("AWS::S3::Bucket"));
      expect(buckets.filter((id) => id.startsWith("CoordinationPluginBundleBucket"))).toHaveLength(
        1,
      );
      expect(buckets.some((id) => id.startsWith("ExecutionArtifactsBucket"))).toBe(false);
      const policies = Object.entries(template.findResources("AWS::IAM::Policy"));
      for (const prefix of [
        "ParticipantPortalLambda",
        "GenericScoring",
        "CoordinationDispatcher",
      ]) {
        const policy = policies.filter(([id]) => id.startsWith(prefix)).map(([, value]) => value);
        expect(JSON.stringify(policy)).toContain("catalogs/*");
        expect(JSON.stringify(policy)).not.toContain("sources/*");
      }
      expect(
        JSON.stringify(policies.filter(([id]) => id.startsWith("CfnDeployFunction"))),
      ).toContain("sources/*");
      const eventStatements = policies
        .filter(([id]) => id.startsWith("EventApiFunction"))
        .flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement);
      const pluginReads = eventStatements.filter((statement) =>
        JSON.stringify(statement.Resource).includes("plugins/*"),
      );
      expect(pluginReads).toHaveLength(1);
      expect(pluginReads[0].Action).toBe("s3:GetObject");
      const artifactBucket = buckets.find((id) => id.startsWith("CoordinationPluginBundleBucket"));
      expect(pluginReads[0].Resource).toEqual(
        ["catalogs", "sources", "plugins"].map((prefix) => ({
          "Fn::Join": ["", [{ "Fn::GetAtt": [artifactBucket, "Arn"] }, `/${prefix}/*`]],
        })),
      );
      // Even an empty current plugin catalog keeps the existing durable coordination artifacts reachable.
      expect(buckets.some((id) => id.startsWith("CoordinationArtifactsBucket"))).toBe(true);
    },
  );

  it("preserves prior keys on update but destroys the owned private versioned bucket on teardown", () => {
    const input = fixture();
    const stack = new Stack(new App(), "PinnedArtifacts");
    const artifacts = new CloudExecutionArtifacts(stack, "ExecutionArtifacts", input);
    expect(artifacts.bucket).toBeDefined();
    Aspects.of(stack).add(new DestroyPolicySetter());
    const template = Template.fromStack(stack);
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
      Properties: {
        VersioningConfiguration: { Status: "Enabled" },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      },
    });
    template.hasResourceProperties("Custom::CDKBucketDeployment", {
      Prune: false,
      RetainOnDelete: false,
    });
  });
});
