import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  contentDigest,
  type DeploymentJob,
} from "../../lib/problem-deploy/control-data/domain/deployment-work.js";
import {
  createCatalogLoader,
  createConnectionVerifier,
  createExecutionArtifactResolver,
  createExecutionCatalogProvider,
  createJobBindingAuthorizer,
  createNativeArtifactResolver,
  createNativeCatalogProvider,
  createNativePluginResolver,
  installationAccountConfig,
  loadExecutionBindings,
  parseRunnerBindings,
  registeredRunnerBinding,
} from "../../lib/problem-deploy/handlers/cloud-api/execution-config.js";

const binding = {
  id: "reviewed",
  accountId: "123456789012",
  region: "us-east-1",
  roleArn: "arn:aws:iam::123456789012:role/Reviewed",
  externalIdParameterArn: "arn:aws:ssm:us-east-1:123456789012:parameter/reviewed",
  reviewedProblemIds: ["hello-world"],
};
const artifact = {
  problemId: "hello-world",
  problemDir: "problems/challenges/hello-world",
  templateBody: "Synthetic template",
  artifactDigest: contentDigest("Synthetic template"),
  scoring: { kind: "flag", points: 100, flagOutputKey: "PrivateFlag", wrongPenalty: 5 },
  parameters: {},
  capabilities: ["CAPABILITY_IAM"],
  publicOutputKeys: ["PublicUrl"],
};
const raw = JSON.stringify({ version: 1, problems: [artifact] });
const key = `catalogs/${contentDigest(raw)}.json`;
function object(value: string) {
  return {
    ContentLength: Buffer.byteLength(value),
    Body: { transformToString: async () => value },
  };
}
function invalidObject(failure: string, value: string) {
  if (failure === "missing") throw new Error("NoSuchKey");
  if (failure === "missing-body") return {};
  if (failure === "large-header") return { ...object(value), ContentLength: 1048577 };
  if (failure === "large-body") return object("x".repeat(1048577));
  return object(`${value} `);
}
beforeEach(() => {
  vi.stubEnv("AWS_REGION", "us-east-1");
  vi.stubEnv("CLOUD_ARTIFACT_BUCKET", "synthetic-artifacts");
  vi.stubEnv("CLOUD_CATALOG_KEY", key);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("content-addressed execution configuration using intercepted SDK calls", () => {
  it("coalesces immutable loads and maps the exact current catalog to API problems", async () => {
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async () => object(raw));
    const load = createCatalogLoader();
    const [a, b] = await Promise.all([load(key), load(key)]);
    expect(a).toEqual(b);
    expect(a.problems[0]).toEqual(artifact);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].input).toEqual({ Bucket: "synthetic-artifacts", Key: key });
    const provider = createExecutionCatalogProvider();
    expect((await provider())["hello-world"]).toMatchObject({ ...artifact, catalogKey: key });
  });
  it("requires configuration and valid content-addressed keys before any SDK read", async () => {
    const send = vi
      .spyOn(S3Client.prototype, "send")
      .mockRejectedValue(new Error("Unexpected request"));
    for (const invalidKey of ["catalogs/latest.json", `bindings/${contentDigest(raw)}.json`])
      await expect(createCatalogLoader()(invalidKey)).rejects.toThrow("Invalid catalog identity");
    vi.stubEnv("CLOUD_ARTIFACT_BUCKET", "");
    expect(() => createCatalogLoader()).toThrow("Missing execution configuration");
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["missing-body", "large-header", "large-body", "digest"])(
    "rejects %s and evicts the rejected cache entry so a valid retry can recover",
    async (failure) => {
      let bad: ReturnType<typeof object> | Record<string, never>;
      if (failure === "missing-body") bad = {};
      else if (failure === "large-header") bad = { ...object(raw), ContentLength: 1048577 };
      else if (failure === "large-body") bad = object("x".repeat(1048577));
      else bad = object(`${raw} `);
      const send = vi
        .spyOn(S3Client.prototype, "send")
        .mockImplementationOnce(async () => bad)
        .mockImplementationOnce(async () => object(raw));
      const load = createCatalogLoader();
      await expect(load(key)).rejects.toThrow();
      expect((await load(key)).problems).toHaveLength(1);
      expect(send).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["template", "private-output"])(
    "rejects a self-consistent outer object with an unsafe %s",
    async (change) => {
      const changed = {
        ...artifact,
        ...(change === "template"
          ? { templateBody: "Different" }
          : { publicOutputKeys: ["PrivateFlag"] }),
      };
      const encoded = JSON.stringify({ version: 1, problems: [changed] });
      vi.spyOn(S3Client.prototype, "send").mockImplementation(async () => object(encoded));
      await expect(
        createCatalogLoader()(`catalogs/${contentDigest(encoded)}.json`),
      ).rejects.toThrow("Unsafe catalog");
    },
  );
  it("resolves the persisted artifact and verifier while new requests use the current catalog", async () => {
    const currentArtifact = {
      ...artifact,
      templateBody: "Current template",
      artifactDigest: contentDigest("Current template"),
      scoring: { ...artifact.scoring, points: 200 },
    };
    const currentRaw = JSON.stringify({ version: 1, problems: [currentArtifact] });
    const currentKey = `catalogs/${contentDigest(currentRaw)}.json`;
    vi.stubEnv("CLOUD_CATALOG_KEY", currentKey);
    vi.stubEnv("CONTROL_PLANE_ACCOUNT", "123456789012");
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
      if (command instanceof GetObjectCommand && command.input.Key === key) return object(raw);
      if (command instanceof GetObjectCommand && command.input.Key === currentKey)
        return object(currentRaw);
      throw new Error("Unexpected object request.");
    });
    const resolve = createExecutionArtifactResolver();
    const job: DeploymentJob = {
      ...artifact,
      scoring: { ...artifact.scoring, kind: "flag" },
      catalogKey: key,
      jobId: "01ARZ3NDEKTSV4RRFFQ69G5FA0",
      eventId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
      teamId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
      status: "PENDING",
      region: binding.region,
      awsAccountId: binding.accountId,
      expiresAt: 1800000000,
      score: 0,
      attempt: 1,
      revision: 0,
      createdAt: "2026-10-01T09:00:00.000Z",
      updatedAt: "2026-10-01T09:00:00.000Z",
      stackName: `tc-cloud-${"a".repeat(40)}`,
      connection: {
        ...binding,
        eventId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
        teamId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
        externalIdParameter: binding.externalIdParameterArn,
        version: 1,
        verifiedAt: "2026-10-01T09:00:00.000Z",
      },
    };
    expect(await resolve(job)).toEqual({
      templateBody: artifact.templateBody,
      artifactDigest: artifact.artifactDigest,
      capabilities: artifact.capabilities,
      publicOutputKeys: artifact.publicOutputKeys,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].input).toEqual({
      Bucket: "synthetic-artifacts",
      Key: key,
      ExpectedBucketOwner: "123456789012",
    });
    expect((await createExecutionCatalogProvider()())["hello-world"]).toEqual({
      ...currentArtifact,
      catalogKey: currentKey,
    });
    await expect(resolve({ ...job, catalogKey: undefined })).rejects.toThrow("no pinned catalog");
    for (const changes of [
      { problemId: "other" },
      { artifactDigest: "c".repeat(64) },
      { problemDir: "problems/challenges/other" },
      { scoring: { ...job.scoring, points: 101 } },
      { scoring: { ...job.scoring, flagOutputKey: "OtherFlag" } },
      { scoring: { ...job.scoring, wrongPenalty: 0 } },
    ])
      await expect(resolve({ ...job, ...changes })).rejects.toThrow("artifact or verifier changed");
  });
  it("loads reviewed bindings from their own immutable private object and rejects duplicate or foreign-account roles", async () => {
    const encoded = JSON.stringify([binding]);
    const bindingsKey = `bindings/${contentDigest(encoded)}.json`;
    vi.stubEnv("CLOUD_RUNNER_BINDINGS_KEY", bindingsKey);
    vi.stubEnv("CONTROL_PLANE_ACCOUNT", "123456789012");
    const send = vi
      .spyOn(S3Client.prototype, "send")
      .mockImplementation(async () => object(encoded));
    expect(await loadExecutionBindings()).toEqual([binding]);
    expect(send.mock.calls[0]?.[0].input).toEqual({
      Bucket: "synthetic-artifacts",
      Key: bindingsKey,
      ExpectedBucketOwner: "123456789012",
    });
    expect(() => parseRunnerBindings(JSON.stringify([binding, binding]))).toThrow("Duplicate");
    expect(() =>
      parseRunnerBindings(JSON.stringify([{ ...binding, accountId: "999999999999" }])),
    ).toThrow("account mismatch");
    expect(() => parseRunnerBindings("[]")).toThrow();
  });
  it("rejects an invalid configured bucket owner before a catalog or binding request", async () => {
    vi.stubEnv("CONTROL_PLANE_ACCOUNT", "invalid");
    const send = vi.spyOn(S3Client.prototype, "send");
    expect(() => createCatalogLoader()).toThrow("Invalid artifact bucket owner");
    await expect(loadExecutionBindings()).rejects.toThrow("Invalid artifact bucket owner");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("connection verification exact secret and temporary credential boundaries", () => {
  it("decrypts only the exact SecureString ARN and assumes the configured role with mandatory ExternalId", async () => {
    const ssm = vi.spyOn(SSMClient.prototype, "send").mockImplementation(async () => ({
      Parameter: {
        ARN: binding.externalIdParameterArn,
        Type: "SecureString",
        Value: "synthetic-external-id",
      },
    }));
    const sts = vi.spyOn(STSClient.prototype, "send").mockImplementation(async () => ({
      Credentials: {
        AccessKeyId: "DUMMYID",
        SecretAccessKey: "DUMMYSECRET",
        SessionToken: "DUMMYTOKEN",
        Expiration: new Date(Date.now() + 60000),
      },
    }));
    expect(await createConnectionVerifier()(binding)).toBeUndefined();
    expect(ssm.mock.calls[0]?.[0].input).toEqual({
      Name: binding.externalIdParameterArn,
      WithDecryption: true,
    });
    expect(sts.mock.calls[0]?.[0].input).toEqual({
      RoleArn: binding.roleArn,
      ExternalId: "synthetic-external-id",
      RoleSessionName: "TenkaCloud-Connection-Verify",
      DurationSeconds: 900,
    });
  });
  it.each([
    {},
    { ARN: binding.externalIdParameterArn, Type: "String", Value: "synthetic" },
    { ARN: "other", Type: "SecureString", Value: "synthetic" },
    { ARN: binding.externalIdParameterArn, Type: "SecureString", Value: "" },
  ])("never assumes a role with an unverified secret: %j", async (Parameter) => {
    vi.spyOn(SSMClient.prototype, "send").mockImplementation(async () => ({ Parameter }));
    const sts = vi
      .spyOn(STSClient.prototype, "send")
      .mockRejectedValue(new Error("Unexpected STS call"));
    await expect(createConnectionVerifier()(binding)).rejects.toThrow("SecureString ExternalId");
    expect(sts).not.toHaveBeenCalled();
  });
  it.each([
    {},
    {
      AccessKeyId: "id",
      SecretAccessKey: "secret",
      SessionToken: "token",
      Expiration: new Date(0),
    },
    { AccessKeyId: "id", SecretAccessKey: "secret", Expiration: new Date(Date.now() + 60000) },
  ])("does not persist an incomplete or expired verification result: %j", async (Credentials) => {
    vi.spyOn(SSMClient.prototype, "send").mockImplementation(async () => ({
      Parameter: { ARN: binding.externalIdParameterArn, Type: "SecureString", Value: "synthetic" },
    }));
    vi.spyOn(STSClient.prototype, "send").mockImplementation(async () => ({ Credentials }));
    await expect(createConnectionVerifier()(binding)).rejects.toThrow("incomplete credentials");
  });
  it("rejects malformed parameter identity before any SDK call", async () => {
    const send = vi
      .spyOn(SSMClient.prototype, "send")
      .mockRejectedValue(new Error("Unexpected SSM call"));
    await expect(
      createConnectionVerifier()({ ...binding, externalIdParameterArn: "invalid" }),
    ).rejects.toThrow("Invalid parameter region");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("installation-scoped registry configuration", () => {
  const hash = "a".repeat(24);
  const roleName = `TenkaCloud-${hash}-deploy-Role`;
  const parameter = `arn:aws:ssm:us-east-1:123456789012:parameter/tenkacloud/cloud/${hash}/external-id`;
  it("accepts only the fixed role and matching installation secret namespace", () => {
    vi.stubEnv("COMPETITOR_ROLE_NAME", roleName);
    vi.stubEnv("COMPETITOR_EXTERNAL_ID_PARAMETER_ARN", parameter);
    expect(installationAccountConfig()).toEqual({ roleName, externalIdParameterArn: parameter });
    for (const value of [
      "Administrator",
      "TenkaCloud-*-deploy-Role",
      roleName.replace(hash, "b".repeat(24)),
    ]) {
      vi.stubEnv("COMPETITOR_ROLE_NAME", value);
      expect(() => installationAccountConfig()).toThrow("Invalid installation");
    }
  });
  it("rejects platform-account verification before looking up any ExternalId or assuming a role", async () => {
    const ssm = vi
      .spyOn(SSMClient.prototype, "send")
      .mockRejectedValue(new Error("Unexpected SSM access"));
    const sts = vi
      .spyOn(STSClient.prototype, "send")
      .mockRejectedValue(new Error("Unexpected STS access"));
    await expect(createConnectionVerifier(binding.accountId)(binding)).rejects.toThrow(
      "Control-plane account",
    );
    expect(ssm).not.toHaveBeenCalled();
    expect(sts).not.toHaveBeenCalled();
  });
  it("refuses unverified or wrong-role records and pins the immutable registration identity", () => {
    const record = {
      awsAccountId: "222222222222",
      region: "us-east-1",
      competitorRoleName: roleName,
      registrationId: "01ARZ3NDEKTSV4RRFFQ69G5FA0",
      revision: 3,
      verified: true,
      verifiedAt: "2026-10-01T00:00:00.000Z",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      createdBy: "synthetic",
    };
    const config = { roleName, externalIdParameterArn: parameter };
    expect(registeredRunnerBinding(record, config, ["hello-world"])).toMatchObject({
      id: `account-${record.registrationId.toLowerCase()}`,
      roleArn: `arn:aws:iam::${record.awsAccountId}:role/${roleName}`,
      externalIdParameterArn: parameter,
      reviewedProblemIds: ["hello-world"],
    });
    expect(
      registeredRunnerBinding(record, config, ["hello-world"], "ap-northeast-1"),
    ).toMatchObject({
      accountId: record.awsAccountId,
      region: "ap-northeast-1",
      roleArn: `arn:aws:iam::${record.awsAccountId}:role/${roleName}`,
      externalIdParameterArn: parameter,
    });
    expect(() => registeredRunnerBinding(record, config, ["hello-world"], "cn-north-1")).toThrow(
      "commercial AWS regions",
    );
    expect(() =>
      registeredRunnerBinding({ ...record, verified: false }, config, ["hello-world"]),
    ).toThrow();
    expect(() =>
      registeredRunnerBinding({ ...record, competitorRoleName: "Administrator" }, config, [
        "hello-world",
      ]),
    ).toThrow();
    expect(() => registeredRunnerBinding(record, config, [])).toThrow();
    expect(() =>
      registeredRunnerBinding({ ...record, awsAccountId: "123456789012" }, config, ["hello-world"]),
    ).toThrow("Control-plane account");
  });
  it("authorizes registered jobs in their pinned team region while retaining registration and scope fences", async () => {
    const record = {
      awsAccountId: "222222222222",
      region: "us-east-1",
      competitorRoleName: roleName,
      registrationId: "01ARZ3NDEKTSV4RRFFQ69G5FA0",
      revision: 1,
      verified: true,
      verifiedAt: "2026-10-01T00:00:00.000Z",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      createdBy: "synthetic",
    };
    const config = { roleName, externalIdParameterArn: parameter };
    const getAccount = vi.fn(async () => record);
    const authorize = createJobBindingAuthorizer({
      bindings: [],
      accounts: { getAccount },
      config,
      controlPlaneAccount: "123456789012",
    });
    const eventId = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
    const teamId = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
    const reviewed = registeredRunnerBinding(record, config, ["hello-world"], "ap-northeast-1");
    const job: DeploymentJob = {
      ...artifact,
      scoring: { ...artifact.scoring, kind: "flag" },
      catalogKey: key,
      jobId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
      eventId,
      teamId,
      status: "PENDING",
      awsAccountId: record.awsAccountId,
      region: reviewed.region,
      expiresAt: 1800000000,
      score: 0,
      attempt: 1,
      revision: 0,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      stackName: `tc-cloud-${"a".repeat(40)}`,
      connection: {
        eventId,
        teamId,
        accountId: reviewed.accountId,
        region: reviewed.region,
        roleArn: reviewed.roleArn,
        externalIdParameter: parameter,
        bindingId: reviewed.id,
        registrationId: record.registrationId,
        reviewedProblemIds: ["hello-world"],
        version: 1,
        verifiedAt: record.verifiedAt,
      },
    };
    await expect(authorize(job)).resolves.toBeUndefined();
    for (const connection of [
      { ...job.connection, eventId: "other-event" },
      { ...job.connection, teamId: "other-team" },
      { ...job.connection, accountId: "333333333333" },
      { ...job.connection, region: "us-east-1" },
      { ...job.connection, roleArn: `arn:aws:iam::${record.awsAccountId}:role/Other` },
      { ...job.connection, externalIdParameter: `${parameter}-other` },
      { ...job.connection, reviewedProblemIds: ["other"] },
      { ...job.connection, registrationId: "01ARZ3NDEKTSV4RRFFQ69G5FA4" },
    ])
      await expect(authorize({ ...job, connection })).rejects.toThrow();
    await expect(
      authorize({
        ...job,
        region: "cn-north-1",
        connection: { ...job.connection, region: "cn-north-1" },
      }),
    ).rejects.toThrow("commercial AWS regions");
    getAccount.mockResolvedValue({ ...record, verified: false });
    await expect(authorize(job)).rejects.toThrow("not verified");
  });
});

describe("native execution saved-pin boundary", () => {
  const source =
    "export default { initialState:()=>({}), validateOp:()=>({ok:true}), applyOp:s=>s, projectForTeam:()=>({safe:true}), teamScores:()=>({}) };";
  const artifactDigest = contentDigest(source);
  const native = {
    kind: "coordination",
    problemId: "ac26-crypto-battle",
    problemDir: "problems/battles/ac26-crypto-battle",
    artifactDigest,
    pluginKey: `plugins/${artifactDigest}.mjs`,
    stateBudget: { bytesPerTeam: 31744, baseBytes: 1536 },
    name: "Battle",
    description: "Reviewed native game",
    instructions: "Play",
  };
  const nativeRaw = JSON.stringify({ version: 1, problems: [], nativeProblems: [native] });
  const catalogKey = `catalogs/${contentDigest(nativeRaw)}.json`;
  const config = {
    artifactBucket: "synthetic-artifacts",
    region: "us-east-1",
    catalogKey,
    expectedBucketOwner: "123456789012",
  };
  const resolvers = [
    ["plugin", createNativePluginResolver],
    ["artifact", createNativeArtifactResolver],
  ] as const;
  describe.each(resolvers)("%s resolver", (_name, createResolver) => {
    it.each(["description-only", "changed-plugin", "removed-problem"])(
      "keeps catalog A's saved pin when current catalog B has %s changes",
      async (change) => {
        const currentSource = source.replace("safe:true", "current:true");
        const currentDigest = contentDigest(currentSource);
        const currentNative = {
          ...native,
          description: "Current description",
          ...(change === "changed-plugin"
            ? { artifactDigest: currentDigest, pluginKey: `plugins/${currentDigest}.mjs` }
            : {}),
        };
        const currentRaw = JSON.stringify({
          version: 1,
          problems: [artifact],
          nativeProblems: change === "removed-problem" ? [] : [currentNative],
        });
        const currentKey = `catalogs/${contentDigest(currentRaw)}.json`;
        const objects: Record<string, string> = {
          [catalogKey]: nativeRaw,
          [currentKey]: currentRaw,
          [native.pluginKey]: source,
          [`plugins/${currentDigest}.mjs`]: currentSource,
        };
        const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
          const value = command instanceof GetObjectCommand && objects[command.input.Key ?? ""];
          if (!value) throw new Error("Unexpected object request.");
          return object(value);
        });
        const currentConfig = { ...config, catalogKey: currentKey };
        const result = await createResolver(currentConfig)({ ...native, catalogKey });
        const plugin = "plugin" in result ? result.plugin : result;
        expect(plugin.projectForTeam({}, "a")).toEqual({ safe: true });
        if ("descriptor" in result) expect(result.descriptor).toEqual({ ...native, catalogKey });
        expect(
          send.mock.calls.every(
            ([command]) =>
              command instanceof GetObjectCommand &&
              command.input.Bucket === config.artifactBucket &&
              command.input.ExpectedBucketOwner === config.expectedBucketOwner &&
              [catalogKey, native.pluginKey].includes(command.input.Key ?? ""),
          ),
        ).toBe(true);

        const currentCatalog = await createNativeCatalogProvider(currentConfig)();
        expect(currentCatalog[native.problemId]).toEqual(
          change === "removed-problem" ? undefined : { ...currentNative, catalogKey: currentKey },
        );
      },
    );
    it("does not fall back to the current catalog when the saved catalog is missing", async () => {
      const currentKey = `catalogs/${"b".repeat(64)}.json`;
      const send = vi.spyOn(S3Client.prototype, "send").mockRejectedValue(new Error("NoSuchKey"));
      const resolve = createResolver({ ...config, catalogKey: currentKey });
      await expect(resolve({ ...native, catalogKey })).rejects.toThrow("NoSuchKey");
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0].input).toEqual({
        Bucket: config.artifactBucket,
        Key: catalogKey,
        ExpectedBucketOwner: config.expectedBucketOwner,
      });
    });
    it.each(["", "catalogs/latest.json", `bindings/${contentDigest(nativeRaw)}.json`])(
      "rejects a malformed saved catalog key before a request: %s",
      async (invalidKey) => {
        const send = vi.spyOn(S3Client.prototype, "send");
        await expect(createResolver(config)({ ...native, catalogKey: invalidKey })).rejects.toThrow(
          "Invalid catalog identity",
        );
        expect(send).not.toHaveBeenCalled();
      },
    );
    it("keeps the supported problem allowlist before loading any retained artifact", async () => {
      const send = vi.spyOn(S3Client.prototype, "send");
      await expect(
        createResolver(config)({ ...native, catalogKey, problemId: "other-problem" }),
      ).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
    });
    it.each(["digest", "plugin-key"])(
      "rejects a changed saved %s even after the genuine bundle has been cached",
      async (change) => {
        const send = vi
          .spyOn(S3Client.prototype, "send")
          .mockImplementation(async (command) =>
            object(
              command instanceof GetObjectCommand && command.input.Key === catalogKey
                ? nativeRaw
                : source,
            ),
          );
        const resolve = createResolver(config);
        await resolve({ ...native, catalogKey });
        const count = send.mock.calls.length;
        const pin = {
          ...native,
          catalogKey,
          ...(change === "digest"
            ? { artifactDigest: "0".repeat(64) }
            : { pluginKey: `plugins/${"0".repeat(64)}.mjs` }),
        };
        await expect(resolve(pin)).rejects.toThrow("Pinned native artifact changed");
        expect(send).toHaveBeenCalledTimes(count);
      },
    );
  });
  it.each(["missing", "missing-body", "large-header", "large-body", "hash-mismatch"])(
    "rejects retained catalog %s and retries the saved key after failure eviction",
    async (failure) => {
      let rejectCatalog = true;
      const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
        if (!(command instanceof GetObjectCommand)) throw new Error("Unexpected request.");
        if (command.input.Key === native.pluginKey) return object(source);
        if (command.input.Key !== catalogKey) throw new Error("Unpinned catalog requested.");
        if (!rejectCatalog) return object(nativeRaw);
        return invalidObject(failure, nativeRaw);
      });
      const resolve = createNativeArtifactResolver({
        ...config,
        catalogKey: `catalogs/${"b".repeat(64)}.json`,
      });
      await expect(resolve({ ...native, catalogKey })).rejects.toThrow();
      rejectCatalog = false;
      expect((await resolve({ ...native, catalogKey })).descriptor).toEqual({
        ...native,
        catalogKey,
      });
      expect(
        send.mock.calls.filter(
          ([command]) => command instanceof GetObjectCommand && command.input.Key === catalogKey,
        ),
      ).toHaveLength(3);
      expect(
        send.mock.calls.filter(
          ([command]) =>
            command instanceof GetObjectCommand && command.input.Key === native.pluginKey,
        ),
      ).toHaveLength(1);
    },
  );
  it.each([
    ["JSON", "{"],
    ["schema", JSON.stringify({ version: 2, problems: [], nativeProblems: [native] })],
    ["missing descriptor", JSON.stringify({ version: 1, problems: [artifact] })],
    [
      "unsupported problem",
      JSON.stringify({
        version: 1,
        problems: [],
        nativeProblems: [{ ...native, problemId: "other" }],
      }),
    ],
    [
      "plugin identity",
      JSON.stringify({
        version: 1,
        problems: [],
        nativeProblems: [{ ...native, pluginKey: `plugins/${"0".repeat(64)}.mjs` }],
      }),
    ],
  ])(
    "rejects a hash-valid retained catalog with invalid %s before loading code",
    async (_failure, invalidRaw) => {
      const invalidKey = `catalogs/${contentDigest(invalidRaw)}.json`;
      const send = vi
        .spyOn(S3Client.prototype, "send")
        .mockImplementation(async () => object(invalidRaw));
      await expect(
        createNativeArtifactResolver(config)({ ...native, catalogKey: invalidKey }),
      ).rejects.toThrow();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0].input).toMatchObject({ Key: invalidKey });
    },
  );
  it("loads the exact reviewed native bundle and exposes no fake CloudFormation problem", async () => {
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) =>
      object(
        command instanceof GetObjectCommand && command.input.Key === catalogKey
          ? nativeRaw
          : source,
      ),
    );
    const catalog = await createNativeCatalogProvider(config)();
    const pin = catalog["ac26-crypto-battle"];
    if (!pin) throw new Error("Native fixture missing.");
    expect(pin).toMatchObject({ ...native, catalogKey });
    const result = await createNativeArtifactResolver(config)(pin);
    expect(result.plugin.projectForTeam({}, "a")).toEqual({ safe: true });
    expect(result.descriptor).not.toHaveProperty("templateBody");
    const calls = vi.mocked(S3Client.prototype.send).mock.calls;
    expect(calls.map(([command]) => command.input)).toEqual(
      expect.arrayContaining([
        { Bucket: "synthetic-artifacts", Key: catalogKey, ExpectedBucketOwner: "123456789012" },
        {
          Bucket: "synthetic-artifacts",
          Key: native.pluginKey,
          ExpectedBucketOwner: "123456789012",
        },
      ]),
    );
    expect(
      calls.every(
        ([command]) =>
          command instanceof GetObjectCommand &&
          command.input.ExpectedBucketOwner === "123456789012",
      ),
    ).toBe(true);
  });
  it.each(["digest", "key", "problem"])(
    "rejects changed %s without reading an unreviewed bundle",
    async (change) => {
      const send = vi
        .spyOn(S3Client.prototype, "send")
        .mockImplementation(async () => object(nativeRaw));
      const pin = { ...native, catalogKey };
      if (change === "digest") pin.artifactDigest = "0".repeat(64);
      else if (change === "key") pin.pluginKey = `plugins/${"0".repeat(64)}.mjs`;
      else pin.problemId = "other";
      await expect(createNativeArtifactResolver(config)(pin)).rejects.toThrow();
      expect(
        send.mock.calls.every(
          ([command]) => command instanceof GetObjectCommand && command.input.Key === catalogKey,
        ),
      ).toBe(true);
    },
  );
  it.each(["missing-body", "large-header", "large-body", "digest"])(
    "checks plugin %s before evaluating code and permits a correct retry",
    async (failure) => {
      const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
        if (command instanceof GetObjectCommand && command.input.Key === catalogKey)
          return object(nativeRaw);
        return invalidObject(failure, source);
      });
      const resolve = createNativeArtifactResolver(config);
      await expect(resolve({ ...native, catalogKey })).rejects.toThrow();
      send.mockImplementation(async (command) =>
        object(
          command instanceof GetObjectCommand && command.input.Key === catalogKey
            ? nativeRaw
            : source,
        ),
      );
      expect((await resolve({ ...native, catalogKey })).plugin.projectForTeam({}, "a")).toEqual({
        safe: true,
      });
      expect(
        send.mock.calls.filter(
          ([command]) =>
            command instanceof GetObjectCommand && command.input.Key === native.pluginKey,
        ),
      ).toHaveLength(2);
    },
  );
  it.each([
    ["default export", "export default undefined;", "Invalid native coordination plugin"],
    [
      "required hooks",
      source.replace("teamScores:()=>({})", "teamScores:undefined"),
      "plugin hooks",
    ],
    [
      "invalid schema version",
      source.replace("initialState:", "stateSchemaVersion:0,initialState:"),
      "plugin schema",
    ],
    [
      "missing migration",
      source.replace("initialState:", "stateSchemaVersion:2,initialState:"),
      "plugin schema",
    ],
  ])(
    "rejects an integrity-checked plugin with %s and evicts the failed plugin cache",
    async (_failure, invalidSource, message) => {
      const invalidDigest = contentDigest(invalidSource);
      const invalidNative = {
        ...native,
        artifactDigest: invalidDigest,
        pluginKey: `plugins/${invalidDigest}.mjs`,
      };
      const invalidRaw = JSON.stringify({
        version: 1,
        problems: [],
        nativeProblems: [invalidNative],
      });
      const invalidKey = `catalogs/${contentDigest(invalidRaw)}.json`;
      const send = vi
        .spyOn(S3Client.prototype, "send")
        .mockImplementation(async (command) =>
          object(
            command instanceof GetObjectCommand && command.input.Key === invalidKey
              ? invalidRaw
              : invalidSource,
          ),
        );
      const resolve = createNativePluginResolver(config);
      const pin = { ...invalidNative, catalogKey: invalidKey };
      await expect(resolve(pin)).rejects.toThrow(message);
      await expect(resolve(pin)).rejects.toThrow(message);
      expect(
        send.mock.calls.filter(
          ([command]) =>
            command instanceof GetObjectCommand && command.input.Key === invalidNative.pluginKey,
        ),
      ).toHaveLength(2);
    },
  );
  it("rejects an invalid expected bucket owner before requesting any object", () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    expect(() =>
      createNativeArtifactResolver({ ...config, expectedBucketOwner: "not-an-account" }),
    ).toThrow("Invalid artifact bucket owner");
    expect(send).not.toHaveBeenCalled();
  });
});
