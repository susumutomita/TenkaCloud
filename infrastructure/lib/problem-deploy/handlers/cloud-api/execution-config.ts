import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { z } from "zod";
import { assertCommercialRegion } from "../../../cloud-hosting/regions.js";
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
export const executionCatalogSchema = z
  .object({ version: z.literal(1), problems: z.array(artifactSchema).min(1).max(50) })
  .strict();
export type ExecutionCatalog = z.infer<typeof executionCatalogSchema>;
function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing execution configuration: ${name}`);
  return value;
}
/** Content-addressed catalog objects pin the actual template and verifier through retries/redeploys. */
function createObjectLoader() {
  const bucket = setting("CLOUD_ARTIFACT_BUCKET");
  const region = setting("AWS_REGION");
  assertCommercialRegion(region);
  const client = new S3Client({ region, ignoreConfiguredEndpointUrls: true });
  const pending = new Map<string, Promise<string>>();
  return async (key: string): Promise<string> => {
    if (!/^(?:catalogs|bindings)\/[a-f0-9]{64}\.json$/u.test(key))
      throw new Error("Invalid catalog identity.");
    const previous = pending.get(key);
    if (previous) return previous;
    const request = client
      .send(new GetObjectCommand({ Bucket: bucket, Key: key }))
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
export function createCatalogLoader() {
  const load = createObjectLoader();
  return async (key: string): Promise<ExecutionCatalog> => parseCatalog(await load(key));
}
export async function loadExecutionBindings(): Promise<readonly RunnerBinding[]> {
  return parseRunnerBindings(await createObjectLoader()(setting("CLOUD_RUNNER_BINDINGS_KEY")));
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
  return catalog;
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
export function createConnectionVerifier() {
  const sts = new STSClient({ region: setting("AWS_REGION"), ignoreConfiguredEndpointUrls: true });
  return async (binding: RunnerBinding): Promise<void> => {
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
