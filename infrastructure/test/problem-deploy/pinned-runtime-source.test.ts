import {
  CreateStackCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
} from "@aws-sdk/client-cloudformation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildArtifactsResolver,
  buildS3ArtifactsResolver,
  createStackForDeployment,
} from "../../lib/problem-deploy/handlers/cfn-deploy-handler/create-stack.js";
import { buildAdapterDependencies } from "../../lib/problem-deploy/handlers/deploy-handler/adapter-dependencies.js";
import type { ResolvedExecutionCatalog } from "../../lib/problem-deploy/handlers/shared/execution-catalog.js";
import { resolveGcpTerraformSource } from "../../lib/problem-deploy/runtime-clients/gcp-blueprint-materializer.js";

const execution = vi.hoisted(() => ({
  currentCatalogKey: vi.fn(),
  loadSavedCatalog: vi.fn(),
  loadExecutionSourceText: vi.fn(),
  loadExecutionSourceBytes: vi.fn(),
}));
vi.mock("../../lib/problem-deploy/handlers/shared/execution-catalog.js", () => execution);
vi.mock("../../lib/problem-deploy/challenge-payload-artifacts.js", () => ({
  fetchChallengePayloadArtifacts: vi.fn(async () => {
    throw new Error("unexpected mutable private payload read");
  }),
  fetchChallengePayloadEntry: vi.fn(async () => {
    throw new Error("unexpected mutable private payload read");
  }),
  fetchChallengePayloadDirectory: vi.fn(async () => {
    throw new Error("unexpected mutable private payload read");
  }),
}));
const catalogKey = `catalogs/${"a".repeat(64)}.json`;
const problemId = "retained-source";
const problemDir = `problems/challenges/${problemId}`;
const sourceA: Record<string, string> = {
  "template.yaml": "Resources: { RetainedA: { Type: AWS::S3::Bucket } }",
  "metadata.json": JSON.stringify({ cfnParameters: { Revision: "A" } }),
  "main.json": JSON.stringify({
    $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
    resources: [],
    metadata: { revision: "A" },
  }),
  "targets/gcp/main.tf": 'resource "retained_a" {}',
  "targets/gcp/module/variables.tf": 'variable "retained_a" {}',
};
const catalog: ResolvedExecutionCatalog = {
  version: 1,
  catalogKey,
  catalog: { [problemId]: problemDir },
  scoring: {},
  hints: {},
  endpoints: {},
  phases: {},
  visibility: {},
  runtimes: {},
  disruptions: {},
  writeups: {},
  provenance: {},
  coordination: {},
  plugins: {},
  sourceArchive: { bucket: "source", key: "source.zip", versionId: "source-A" },
  sources: {
    [problemId]: Object.fromEntries(
      Object.keys(sourceA).map((path) => [
        path,
        { key: `sources/${"a".repeat(64)}`, digest: "a".repeat(64) },
      ]),
    ),
  },
};
const detail = {
  jobId: "01HX0000000000000000000ABC",
  tenantId: "tenant",
  problemId,
  problemDir,
  teamSlug: "team",
  namePrefix: "tc-retained-team",
  region: "ap-northeast-1",
  awsAccountId: "123456789012",
  competitorRoleArn: "arn:aws:iam::123456789012:role/CompetitorDeploy",
  externalIdParameterName: "/test/tenant/external-id",
  catalogKey,
  sourceVersion: "source-A",
  challengePayloadUrl: "https://example.invalid/latest-B.zip",
};

beforeEach(() => {
  vi.resetAllMocks();
  execution.currentCatalogKey.mockReturnValue(`catalogs/${"b".repeat(64)}.json`);
  execution.loadSavedCatalog.mockResolvedValue(catalog);
  execution.loadExecutionSourceText.mockImplementation(
    async (_catalog, _problemId, path: string) => {
      if (!(path in sourceA)) throw new Error("Pinned execution source is missing.");
      return sourceA[path];
    },
  );
  execution.loadExecutionSourceBytes.mockImplementation(
    async (_catalog, _problemId, path: string) => {
      if (!(path in sourceA)) throw new Error("Pinned execution source is missing.");
      return new TextEncoder().encode(sourceA[path]);
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("saved execution source replay", () => {
  it("replays CFN A after the current catalog, source tree, and private URL advance to B", async () => {
    const send = vi.fn().mockRejectedValue(new Error("must not read mutable source B"));
    const payload = vi.fn().mockRejectedValue(new Error("must not fetch private B"));
    const resolve = buildArtifactsResolver({
      resolveFromS3: buildS3ArtifactsResolver({ send }, { sourceBucket: "latest-B" }),
      fetchPayloadArtifacts: payload,
    });
    expect(await resolve(detail)).toEqual({
      templateBody: sourceA["template.yaml"],
      cfnParameters: { Revision: "A" },
    });
    expect(execution.loadSavedCatalog).toHaveBeenCalledWith(catalogKey);
    expect(send).not.toHaveBeenCalled();
    expect(payload).not.toHaveBeenCalled();
  });

  it.each(["create", "update", "noop", "recreate"])(
    "keeps pinned artifacts for CFN %s",
    async (operation) => {
      const send = vi.fn(async (command: unknown) => {
        if (command instanceof DescribeStacksCommand) {
          if (operation === "create") throw new Error("stack does not exist");
          return {
            Stacks: [
              {
                StackStatus: operation === "recreate" ? "ROLLBACK_COMPLETE" : "CREATE_COMPLETE",
                StackId: "retained-stack",
              },
            ],
          };
        }
        if (command instanceof UpdateStackCommand && operation === "noop")
          throw new Error("No updates are to be performed.");
        return { StackId: "retained-stack" };
      });
      const result = await createStackForDeployment(
        { detail },
        {
          ssm: { send: vi.fn().mockResolvedValue({ Parameter: { Value: "current-external-id" } }) },
          sts: {
            send: vi.fn().mockResolvedValue({
              Credentials: { AccessKeyId: "test", SecretAccessKey: "test", SessionToken: "test" },
            }),
          },
          cfnClient: () => ({ send }),
          resolveArtifacts: buildArtifactsResolver({
            resolveFromS3: buildS3ArtifactsResolver({ send: vi.fn() }, { sourceBucket: "B" }),
          }),
          tenkaCloudAccountId: "999988887777",
          waitForStackDelete: vi.fn(),
        },
      );
      expect(result.operation).toBe(operation === "recreate" ? "create" : operation);
      const submission = send.mock.calls
        .map(([command]) => command)
        .find(
          (command) =>
            command instanceof CreateStackCommand || command instanceof UpdateStackCommand,
        ) as CreateStackCommand | UpdateStackCommand;
      expect(submission.input.TemplateBody).toBe(sourceA["template.yaml"]);
      expect(submission.input.Parameters).toContainEqual({
        ParameterKey: "Revision",
        ParameterValue: "A",
      });
    },
  );

  it("rejects a pinned problem directory mismatch before mutable reads", async () => {
    const send = vi.fn();
    await expect(
      buildS3ArtifactsResolver(
        { send },
        { sourceBucket: "B" },
      )({ ...detail, problemDir: "problems/other" }),
    ).rejects.toThrow(/directory.*catalog/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("fails closed when a pinned template is missing", async () => {
    execution.loadExecutionSourceText.mockRejectedValue(
      new Error("Pinned execution source is missing."),
    );
    const send = vi.fn();
    await expect(buildS3ArtifactsResolver({ send }, { sourceBucket: "B" })(detail)).rejects.toThrow(
      /Pinned execution source is missing/,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("materializes Azure A without touching current credentials or source B", async () => {
    const send = vi.fn();
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const deps = buildAdapterDependencies(
      {
        env: "test",
        tenantId: "tenant",
        events: { send } as unknown as EventBridgeClient,
        eventBusName: "events",
        ssm: { send },
        s3: { send },
        sourceBucketName: "latest-B",
      },
      { provider: "azure", engine: "bicep", entry: "main.json" },
      "team",
    );
    if (!deps.azure) throw new Error("missing Azure adapter");
    const result = await deps.azure.materialize("main.json", {
      problemId,
      problemDir,
      catalogKey,
      challengePayloadUrl: detail.challengePayloadUrl,
    });
    expect(result.document).toEqual(JSON.parse(sourceA["main.json"]));
    expect(execution.loadSavedCatalog).toHaveBeenCalledWith(catalogKey);
    expect(send).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("replays exactly the GCP A manifest without listing a mutable bucket or fetching private B", async () => {
    const send = vi.fn();
    const fetchPayloadDirectory = vi.fn();
    const files = await resolveGcpTerraformSource(
      {
        problemId,
        problemDir,
        entry: "targets/gcp",
        catalogKey,
        challengePayloadUrl: detail.challengePayloadUrl,
      },
      { s3: { send }, sourceBucketName: "latest-B", fetchPayloadDirectory },
    );
    expect(
      files.map((file) => ({
        relativePath: file.relativePath,
        text: new TextDecoder().decode(file.bytes),
      })),
    ).toEqual([
      { relativePath: "main.tf", text: sourceA["targets/gcp/main.tf"] },
      { relativePath: "module/variables.tf", text: sourceA["targets/gcp/module/variables.tf"] },
    ]);
    expect(execution.loadSavedCatalog).toHaveBeenCalledWith(catalogKey);
    expect(send).not.toHaveBeenCalled();
    expect(fetchPayloadDirectory).not.toHaveBeenCalled();
  });

  it("rejects a GCP module absent from A rather than using B", async () => {
    const send = vi.fn();
    await expect(
      resolveGcpTerraformSource(
        { problemId, problemDir, entry: "new-in-B", catalogKey },
        { s3: { send }, sourceBucketName: "B" },
      ),
    ).rejects.toThrow(/Pinned.*source.*missing/i);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { competitorRoleArn: undefined, externalIdParameterName: undefined },
    { competitorRoleArn: "arn:aws:iam::999988887777:role/HostingRole" },
    { externalIdParameterName: undefined },
  ])(
    "rejects pinned AWS input without a role and ExternalId for its declared account",
    async (override) => {
      const send = vi.fn();
      const resolveArtifacts = vi.fn();
      await expect(
        createStackForDeployment(
          { detail: { ...detail, ...override } },
          {
            ssm: { send },
            sts: { send },
            cfnClient: () => ({ send }),
            resolveArtifacts,
            tenkaCloudAccountId: "999988887777",
          },
        ),
      ).rejects.toThrow(/competitor_account_required/);
      expect(send).not.toHaveBeenCalled();
      expect(resolveArtifacts).not.toHaveBeenCalled();
    },
  );

  it("rejects deployment into the hosting account before any provider call", async () => {
    const send = vi.fn();
    const resolveArtifacts = vi.fn();
    await expect(
      createStackForDeployment(
        { detail },
        {
          ssm: { send },
          sts: { send },
          cfnClient: () => ({ send }),
          resolveArtifacts,
          tenkaCloudAccountId: detail.awsAccountId,
        },
      ),
    ).rejects.toMatchObject({ code: "unsupported_hosting_account" });
    expect(send).not.toHaveBeenCalled();
    expect(resolveArtifacts).not.toHaveBeenCalled();
  });
});
