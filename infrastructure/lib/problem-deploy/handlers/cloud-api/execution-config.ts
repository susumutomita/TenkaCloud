import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type { CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import { z } from "zod";
import { assertCommercialRegion } from "../../../cloud-hosting/regions.js";
import type {
  CompetitorAccountRecord,
  CompetitorAccountsRepository,
  InstallationCompetitorConfig,
} from "../../control-data/domain/competitor-accounts.js";
import { contentDigest, type DeploymentJob } from "../../control-data/domain/deployment-work.js";
import type { CloudProblem } from "./deployment-routes.js";

export const runnerBindingSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    accountId: z.string().regex(/^\d{12}$/u),
    region: z.string(),
    roleArn: z.string().regex(/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@/_-]+$/u),
    externalIdParameterArn: z
      .string()
      .regex(/^arn:aws:ssm:[a-z]{2}(?:-[a-z]+)+-\d+:\d{12}:parameter\/[A-Za-z0-9/_.-]+$/u),
    reviewedProblemIds: z.array(z.string().min(1).max(128)).min(1).max(50),
  })
  .strict()
  .superRefine((binding, context) => {
    assertCommercialRegion(binding.region);
    assertCommercialRegion(binding.externalIdParameterArn.split(":")[3] ?? "");
    if (binding.roleArn.split(":")[4] !== binding.accountId)
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Binding role account mismatch." });
  });
export type RunnerBinding = z.infer<typeof runnerBindingSchema>;
export function parseRunnerBindings(raw: string): readonly RunnerBinding[] {
  const bindings = z
    .array(runnerBindingSchema)
    .min(1)
    .max(49)
    .parse(JSON.parse(raw) as unknown);
  if (new Set(bindings.map((binding) => binding.id)).size !== bindings.length)
    throw new Error("Duplicate runner binding IDs.");
  return bindings;
}
const artifactSchema = z
  .object({
    problemId: z.string(),
    problemDir: z.string(),
    templateBody: z.string().min(1),
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    scoring: z.object({
      kind: z.literal("flag"),
      points: z.number().int().positive(),
      flagOutputKey: z.string(),
      wrongPenalty: z.number().int().nonnegative(),
    }),
    parameters: z.record(z.string()),
    capabilities: z.array(z.enum(["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"])),
    publicOutputKeys: z.array(z.string()).max(16),
  })
  .strict();
export const nativeArtifactSchema = z
  .object({
    kind: z.literal("coordination"),
    problemId: z.literal("ac26-crypto-battle"),
    problemDir: z.literal("problems/battles/ac26-crypto-battle"),
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    pluginKey: z.string().regex(/^plugins\/[a-f0-9]{64}\.mjs$/u),
    stateBudget: z
      .object({
        bytesPerTeam: z.number().int().positive(),
        baseBytes: z.number().int().nonnegative(),
      })
      .strict(),
    name: z.string(),
    description: z.string(),
    instructions: z.string(),
    i18n: z
      .object({
        en: z
          .object({
            name: z.string().optional(),
            description: z.string().optional(),
            instructions: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type NativeProblem = z.infer<typeof nativeArtifactSchema> & { readonly catalogKey: string };
export const executionCatalogSchema = z
  .object({
    version: z.literal(1),
    problems: z.array(artifactSchema).max(50),
    nativeProblems: z.array(nativeArtifactSchema).max(1).optional(),
  })
  .strict();
export type ExecutionCatalog = z.infer<typeof executionCatalogSchema>;
function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing execution configuration: ${name}`);
  return value;
}
/** Content-addressed catalog objects pin the actual template and verifier through retries/redeploys. */
export interface NativeExecutionSettings {
  readonly artifactBucket: string;
  readonly region: string;
  readonly catalogKey: string;
  readonly expectedBucketOwner?: string;
}
function nativeSettings(): NativeExecutionSettings {
  return {
    artifactBucket: setting("CLOUD_ARTIFACT_BUCKET"),
    region: setting("AWS_REGION"),
    catalogKey: setting("CLOUD_CATALOG_KEY"),
    ...(process.env.CONTROL_PLANE_ACCOUNT
      ? { expectedBucketOwner: process.env.CONTROL_PLANE_ACCOUNT }
      : {}),
  };
}
function createObjectLoader(
  config?: Pick<NativeExecutionSettings, "artifactBucket" | "region" | "expectedBucketOwner">,
) {
  const bucket = config?.artifactBucket ?? setting("CLOUD_ARTIFACT_BUCKET");
  const region = config?.region ?? setting("AWS_REGION");
  assertCommercialRegion(region);
  if (config?.expectedBucketOwner !== undefined && !/^\d{12}$/u.test(config.expectedBucketOwner))
    throw new Error("Invalid artifact bucket owner.");
  const client = new S3Client({ region, ignoreConfiguredEndpointUrls: true });
  const pending = new Map<string, Promise<string>>();
  return async (key: string): Promise<string> => {
    if (!/^(?:catalogs|bindings)\/[a-f0-9]{64}\.json$/u.test(key))
      throw new Error("Invalid catalog identity.");
    const previous = pending.get(key);
    if (previous) return previous;
    const request = client
      .send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(config?.expectedBucketOwner
            ? { ExpectedBucketOwner: config.expectedBucketOwner }
            : {}),
        }),
      )
      .then(async (output) => {
        if ((output.ContentLength ?? 0) > 1024 * 1024 || !output.Body)
          throw new Error("Invalid catalog object.");
        const raw = await output.Body.transformToString("utf8");
        const namespace = key.split("/")[0];
        if (
          Buffer.byteLength(raw, "utf8") > 1024 * 1024 ||
          `${namespace}/${contentDigest(raw)}.json` !== key
        )
          throw new Error("Catalog integrity mismatch.");
        return raw;
      });
    if (pending.size >= 16) pending.clear();
    pending.set(key, request);
    try {
      return await request;
    } catch (error) {
      pending.delete(key);
      throw error;
    }
  };
}
export function createCatalogLoader(
  config?: Pick<NativeExecutionSettings, "artifactBucket" | "region" | "expectedBucketOwner">,
) {
  const load = createObjectLoader(config);
  return async (key: string): Promise<ExecutionCatalog> => parseCatalog(await load(key));
}
export async function loadExecutionBindings(): Promise<readonly RunnerBinding[]> {
  const raw = await createObjectLoader()(setting("CLOUD_RUNNER_BINDINGS_KEY"));
  return raw === "[]" ? [] : parseRunnerBindings(raw);
}
function parseCatalog(raw: string): ExecutionCatalog {
  const catalog = executionCatalogSchema.parse(JSON.parse(raw) as unknown);
  for (const problem of catalog.problems) {
    if (
      contentDigest(problem.templateBody) !== problem.artifactDigest ||
      problem.publicOutputKeys.includes(problem.scoring.flagOutputKey)
    )
      throw new Error("Unsafe catalog output or template digest.");
  }
  const ids = [...catalog.problems, ...(catalog.nativeProblems ?? [])].map(
    (problem) => problem.problemId,
  );
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error("Invalid catalog problems.");
  for (const problem of catalog.nativeProblems ?? []) {
    if (problem.pluginKey !== `plugins/${problem.artifactDigest}.mjs`)
      throw new Error("Native artifact identity mismatch.");
  }
  return catalog;
}
export function createNativeCatalogProvider(config: NativeExecutionSettings = nativeSettings()) {
  const load = createCatalogLoader(config);
  const key = config.catalogKey;
  return async (): Promise<Readonly<Record<string, NativeProblem>>> =>
    Object.fromEntries(
      ((await load(key)).nativeProblems ?? []).map((problem) => [
        problem.problemId,
        { ...problem, catalogKey: key },
      ]),
    );
}
function assertNativePlugin(
  plugin: CoordinationPlugin<unknown, unknown> | undefined,
): asserts plugin is CoordinationPlugin<unknown, unknown> {
  if (!plugin) throw new Error("Invalid native coordination plugin.");
  if (
    ![
      plugin.initialState,
      plugin.validateOp,
      plugin.applyOp,
      plugin.projectForTeam,
      plugin.teamScores,
    ].every((hook) => typeof hook === "function")
  )
    throw new Error("Invalid native coordination plugin hooks.");
  const version = plugin.stateSchemaVersion ?? 1;
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    (version > 1 && typeof plugin.migrateState !== "function")
  )
    throw new Error("Invalid native coordination plugin schema.");
}
/** Only the currently configured, reviewed pin can execute; retained mismatches fail closed. */
export function createNativePluginResolver(config: NativeExecutionSettings = nativeSettings()) {
  const load = createCatalogLoader(config);
  const bucket = config.artifactBucket;
  const client = new S3Client({ region: config.region, ignoreConfiguredEndpointUrls: true });
  const pending = new Map<string, Promise<CoordinationPlugin<unknown, unknown>>>();
  return async (pin: {
    readonly catalogKey: string;
    readonly problemId: string;
    readonly artifactDigest: string;
    readonly pluginKey: string;
  }) => {
    if (pin.catalogKey !== config.catalogKey || pin.problemId !== "ac26-crypto-battle")
      throw new Error("Native run is not the currently reviewed artifact.");
    const descriptor = (await load(config.catalogKey)).nativeProblems?.find(
      (item) => item.problemId === "ac26-crypto-battle",
    );
    if (
      !descriptor ||
      descriptor.artifactDigest !== pin.artifactDigest ||
      descriptor.pluginKey !== pin.pluginKey
    )
      throw new Error("Pinned native artifact changed.");
    let request = pending.get(pin.pluginKey);
    if (!request) {
      request = (async () => {
        const output = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: pin.pluginKey,
            ...(config.expectedBucketOwner
              ? { ExpectedBucketOwner: config.expectedBucketOwner }
              : {}),
          }),
        );
        if (!output.Body || (output.ContentLength ?? 0) > 1024 * 1024)
          throw new Error("Invalid native plugin object.");
        const source = await output.Body.transformToString("utf8");
        if (
          Buffer.byteLength(source, "utf8") > 1024 * 1024 ||
          contentDigest(source) !== pin.artifactDigest
        )
          throw new Error("Native plugin integrity mismatch.");
        const module = (await import(
          `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
        )) as { default?: CoordinationPlugin<unknown, unknown> };
        const plugin = module.default;
        assertNativePlugin(plugin);
        return plugin;
      })();
      if (pending.size >= 16) pending.clear();
      pending.set(pin.pluginKey, request);
    }
    try {
      return await request;
    } catch (error) {
      pending.delete(pin.pluginKey);
      throw error;
    }
  };
}
export function createNativeArtifactResolver(config: NativeExecutionSettings = nativeSettings()) {
  const load = createCatalogLoader(config);
  const plugin = createNativePluginResolver(config);
  return async (pin: {
    readonly catalogKey: string;
    readonly problemId: string;
    readonly artifactDigest: string;
    readonly pluginKey: string;
  }) => {
    if (pin.catalogKey !== config.catalogKey || pin.problemId !== "ac26-crypto-battle")
      throw new Error("Native run is not the currently reviewed artifact.");
    const descriptor = (await load(config.catalogKey)).nativeProblems?.find(
      (item) => item.problemId === "ac26-crypto-battle",
    );
    if (
      !descriptor ||
      descriptor.artifactDigest !== pin.artifactDigest ||
      descriptor.pluginKey !== pin.pluginKey
    )
      throw new Error("Pinned native artifact changed.");
    return { descriptor: { ...descriptor, catalogKey: pin.catalogKey }, plugin: await plugin(pin) };
  };
}
export function createExecutionCatalogProvider() {
  const load = createCatalogLoader();
  const key = setting("CLOUD_CATALOG_KEY");
  return async (): Promise<Readonly<Record<string, CloudProblem>>> =>
    Object.fromEntries(
      (await load(key)).problems.map((problem) => [
        problem.problemId,
        { ...problem, catalogKey: key },
      ]),
    );
}
export function createExecutionArtifactResolver() {
  const load = createCatalogLoader();
  return async (job: DeploymentJob) => {
    if (!job.catalogKey) throw new Error("Job has no pinned catalog.");
    const artifact = (await load(job.catalogKey)).problems.find(
      (problem) => problem.problemId === job.problemId,
    );
    if (
      !artifact ||
      artifact.artifactDigest !== job.artifactDigest ||
      artifact.problemDir !== job.problemDir ||
      JSON.stringify(artifact.scoring) !== JSON.stringify(job.scoring)
    )
      throw new Error("Job artifact or verifier changed.");
    return {
      templateBody: artifact.templateBody,
      artifactDigest: artifact.artifactDigest,
      capabilities: artifact.capabilities,
      publicOutputKeys: artifact.publicOutputKeys,
    };
  };
}
/** Historical verify.ts's ExternalId-bearing STS sanity check, restricted to an explicit configured binding. */
export function createConnectionVerifier(controlPlaneAccount?: string) {
  const sts = new STSClient({ region: setting("AWS_REGION"), ignoreConfiguredEndpointUrls: true });
  return async (binding: RunnerBinding): Promise<void> => {
    if (binding.accountId === controlPlaneAccount)
      throw new Error("Control-plane account cannot host competitor resources.");
    const region = binding.externalIdParameterArn.split(":")[3];
    if (!region) throw new Error("Invalid parameter region.");
    const ssm = new SSMClient({ region, ignoreConfiguredEndpointUrls: true });
    const output = await ssm.send(
      new GetParameterCommand({ Name: binding.externalIdParameterArn, WithDecryption: true }),
    );
    if (
      output.Parameter?.ARN !== binding.externalIdParameterArn ||
      output.Parameter.Type !== "SecureString" ||
      !output.Parameter.Value
    )
      throw new Error("Verified SecureString ExternalId is required.");
    const result = await sts.send(
      new AssumeRoleCommand({
        RoleArn: binding.roleArn,
        ExternalId: output.Parameter.Value,
        RoleSessionName: "TenkaCloud-Connection-Verify",
        DurationSeconds: 900,
      }),
    );
    const credentials = result.Credentials;
    if (
      !credentials?.AccessKeyId ||
      !credentials.SecretAccessKey ||
      !credentials.SessionToken ||
      !credentials.Expiration ||
      credentials.Expiration.getTime() <= Date.now()
    )
      throw new Error("Connection verification returned incomplete credentials.");
  };
}

export function installationAccountConfig(): InstallationCompetitorConfig {
  const roleName = setting("COMPETITOR_ROLE_NAME");
  const externalIdParameterArn = setting("COMPETITOR_EXTERNAL_ID_PARAMETER_ARN");
  const hash = /^TenkaCloud-([a-f0-9]{24})-deploy-Role$/u.exec(roleName)?.[1];
  if (
    !hash ||
    !new RegExp(
      `^arn:aws:ssm:[a-z0-9-]+:\\d{12}:parameter/tenkacloud/cloud/${hash}/external-id$`,
      "u",
    ).test(externalIdParameterArn)
  )
    throw new Error("Invalid installation account configuration.");
  return { roleName, externalIdParameterArn };
}

export function registeredRunnerBinding(
  record: CompetitorAccountRecord,
  config: InstallationCompetitorConfig,
  reviewedProblemIds: readonly string[],
  region = record.region,
): RunnerBinding {
  if (record.awsAccountId === config.externalIdParameterArn.split(":")[4])
    throw new Error("Control-plane account cannot host competitor resources.");
  if (!record.verified || record.competitorRoleName !== config.roleName)
    throw new Error("Competitor registration is not verified for this installation.");
  return runnerBindingSchema.parse({
    id: `account-${record.registrationId.toLowerCase()}`,
    accountId: record.awsAccountId,
    // IAM verification is account-scoped; each event/team pins its own commercial region.
    region,
    roleArn: `arn:aws:iam::${record.awsAccountId}:role/${config.roleName}`,
    externalIdParameterArn: config.externalIdParameterArn,
    reviewedProblemIds,
  });
}

/** The runner and participant issuance both use the current registry, including revocation/recreation. */
export function createJobBindingAuthorizer(options: {
  readonly bindings: readonly RunnerBinding[];
  readonly accounts: Pick<CompetitorAccountsRepository, "getAccount">;
  readonly config?: InstallationCompetitorConfig;
  readonly controlPlaneAccount: string;
}) {
  return async (job: DeploymentJob): Promise<void> => {
    if (job.awsAccountId === options.controlPlaneAccount)
      throw new Error("Control-plane account cannot host competitor resources.");
    if (
      job.connection.eventId !== job.eventId ||
      job.connection.teamId !== job.teamId ||
      job.connection.accountId !== job.awsAccountId ||
      job.connection.region !== job.region
    )
      throw new Error("Deployment connection scope mismatch.");
    let allowed = options.bindings;
    if (job.connection.registrationId !== undefined) {
      const record = await options.accounts.getAccount(job.awsAccountId);
      if (!options.config || !record || job.connection.registrationId !== record.registrationId)
        throw new Error("Competitor registration changed.");
      allowed = [
        registeredRunnerBinding(
          record,
          options.config,
          job.connection.reviewedProblemIds ?? [],
          job.connection.region,
        ),
      ];
    }
    if (
      !allowed.some(
        (binding) =>
          binding.id === job.connection.bindingId &&
          binding.accountId === job.awsAccountId &&
          binding.region === job.region &&
          binding.roleArn === job.connection.roleArn &&
          binding.externalIdParameterArn === job.connection.externalIdParameter &&
          binding.reviewedProblemIds.includes(job.problemId) &&
          job.connection.reviewedProblemIds?.includes(job.problemId),
      )
    )
      throw new Error("Deployment binding is no longer authorized.");
  };
}
