import { createHash } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const catalogKeySchema = z.string().regex(/^catalogs\/[a-f0-9]{64}\.json$/u);
const projectionSchema = z.record(z.unknown());
const sourceSchema = z
  .object({ key: z.string().regex(/^sources\/[a-f0-9]{64}$/u), digest: digestSchema })
  .strict();
const pluginSchema = z
  .object({ key: z.string().regex(/^plugins\/[a-f0-9]{64}\.mjs$/u), digest: digestSchema })
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
export const executionCatalogSchema = z
  .object({
    version: z.literal(1),
    nativeProblems: z.array(nativeArtifactSchema).max(1).optional(),
    catalog: z.record(z.string().min(1)),
    scoring: projectionSchema,
    hints: projectionSchema,
    endpoints: projectionSchema,
    phases: projectionSchema,
    visibility: projectionSchema,
    runtimes: projectionSchema,
    disruptions: projectionSchema,
    writeups: projectionSchema,
    provenance: projectionSchema,
    coordination: projectionSchema,
    plugins: z.record(pluginSchema),
    sources: z.record(z.record(sourceSchema)),
    sourceArchive: z
      .object({
        bucket: z.string().min(1),
        key: z.string().min(1),
        versionId: z
          .string()
          .min(1)
          .refine((value) => value !== "null"),
      })
      .strict(),
  })
  .strict();
export type ExecutionCatalog = z.infer<typeof executionCatalogSchema>;
export type ResolvedExecutionCatalog = ExecutionCatalog & { readonly catalogKey: string };
export type ExecutionArtifactReference = z.infer<typeof sourceSchema>;
export const MAX_EXECUTION_CATALOG_BYTES = 16 * 1024 * 1024;
export const MAX_EXECUTION_SOURCE_BYTES = 25 * 1024 * 1024;
export const MAX_EXECUTION_PLUGIN_BYTES = 1024 * 1024;

/** The published da2 content-address identity, shared by producer and every reader. */
export function contentDigest(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function currentCatalogKey(): string | undefined {
  const key = process.env.CLOUD_CATALOG_KEY;
  return key ? catalogKeySchema.parse(key) : undefined;
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing execution configuration: ${name}`);
  return value;
}
export interface ExecutionArtifactSettings {
  readonly artifactBucket: string;
  readonly region?: string;
  readonly expectedBucketOwner?: string;
  readonly s3?: Pick<S3Client, "send">;
}
function settings(): ExecutionArtifactSettings {
  return {
    artifactBucket: required("CLOUD_ARTIFACT_BUCKET"),
    region: required("AWS_REGION"),
    expectedBucketOwner: required("CONTROL_PLANE_ACCOUNT"),
  };
}

function artifactIdentity(key: string) {
  const patterns = [
    { pattern: /^catalogs\/([a-f0-9]{64})\.json$/u, maximum: MAX_EXECUTION_CATALOG_BYTES },
    { pattern: /^plugins\/([a-f0-9]{64})\.mjs$/u, maximum: MAX_EXECUTION_PLUGIN_BYTES },
    { pattern: /^sources\/([a-f0-9]{64})$/u, maximum: MAX_EXECUTION_SOURCE_BYTES },
  ];
  for (const item of patterns) {
    const match = item.pattern.exec(key);
    if (match) return { digest: match[1], maximum: item.maximum };
  }
  throw new Error("Invalid execution artifact identity.");
}
async function boundedBytes(
  body: ReadableStream<Uint8Array>,
  maximum: number,
): Promise<Uint8Array> {
  const stream = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await stream.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) throw new Error("Execution artifact exceeds its byte limit.");
      chunks.push(next.value);
    }
  } catch (error) {
    await stream.cancel().catch(() => undefined);
    throw error;
  } finally {
    stream.releaseLock();
  }
  return Buffer.concat(chunks, length);
}
async function readVerifiedObject(
  client: Pick<S3Client, "send">,
  config: ExecutionArtifactSettings,
  key: string,
): Promise<Uint8Array> {
  const identity = artifactIdentity(key);
  const output = await client.send(
    new GetObjectCommand({
      Bucket: config.artifactBucket,
      Key: key,
      ...(config.expectedBucketOwner ? { ExpectedBucketOwner: config.expectedBucketOwner } : {}),
    }),
  );
  if (!output.Body || (output.ContentLength ?? 0) > identity.maximum)
    throw new Error("Invalid or oversized execution artifact.");
  const bytes = await boundedBytes(output.Body.transformToWebStream(), identity.maximum);
  if (contentDigest(bytes) !== identity.digest)
    throw new Error("Execution artifact integrity mismatch.");
  return bytes;
}
/** Reject oversized streams before buffering; verify bytes before parsing or executing. */
export function createExecutionObjectLoader(config: ExecutionArtifactSettings = settings()) {
  if (config.expectedBucketOwner && !/^\d{12}$/u.test(config.expectedBucketOwner))
    throw new Error("Invalid artifact bucket owner.");
  const client =
    config.s3 ?? new S3Client({ region: config.region, ignoreConfiguredEndpointUrls: true });
  const pending = new Map<string, Promise<Uint8Array>>();
  return async (key: string): Promise<Uint8Array> => {
    artifactIdentity(key);
    const previous = pending.get(key);
    if (previous) return Uint8Array.from(await previous);
    const request = readVerifiedObject(client, config, key);
    // Four bounded catalogs/plugins at most; source files leave the cache after each read.
    if (pending.size >= 4) pending.clear();
    pending.set(key, request);
    try {
      const bytes = await request;
      if (key.startsWith("sources/")) pending.delete(key);
      return Uint8Array.from(bytes);
    } catch (error) {
      pending.delete(key);
      throw error;
    }
  };
}
function assertNativeIdentities(catalog: ExecutionCatalog): void {
  for (const native of catalog.nativeProblems ?? []) {
    const plugin = catalog.plugins[native.problemId];
    if (
      catalog.catalog[native.problemId] !== native.problemDir ||
      plugin?.key !== native.pluginKey ||
      plugin.digest !== native.artifactDigest
    )
      throw new Error("Native artifact identity mismatch.");
  }
}
export function parseExecutionCatalog(raw: string): ExecutionCatalog {
  const catalog = executionCatalogSchema.parse(JSON.parse(raw) as unknown);
  for (const [problemId, files] of Object.entries(catalog.sources)) {
    if (!Object.hasOwn(catalog.catalog, problemId))
      throw new Error("Unknown execution source problem.");
    for (const [relativePath, file] of Object.entries(files)) {
      if (
        !relativePath ||
        relativePath.startsWith("/") ||
        relativePath.includes("\\") ||
        relativePath.split("/").some((part) => part === ".." || part === "." || !part) ||
        file.key !== `sources/${file.digest}`
      ) {
        throw new Error("Invalid execution source identity.");
      }
    }
  }
  for (const [problemId, plugin] of Object.entries(catalog.plugins)) {
    if (!Object.hasOwn(catalog.catalog, problemId) || plugin.key !== `plugins/${plugin.digest}.mjs`)
      throw new Error("Invalid execution plugin identity.");
  }
  assertNativeIdentities(catalog);
  return catalog;
}
export function createCatalogLoader(config?: ExecutionArtifactSettings) {
  const load = createExecutionObjectLoader(config);
  return async (key: string): Promise<ResolvedExecutionCatalog> => {
    catalogKeySchema.parse(key);
    // Parse anew: callers cannot modify a cached object observed by another event.
    return {
      ...parseExecutionCatalog(Buffer.from(await load(key)).toString("utf8")),
      catalogKey: key,
    };
  };
}
let defaultLoader: ReturnType<typeof createCatalogLoader> | undefined;
let defaultObjects: ReturnType<typeof createExecutionObjectLoader> | undefined;
export function loadExecutionCatalog(key: string): Promise<ResolvedExecutionCatalog> {
  catalogKeySchema.parse(key);
  defaultLoader ??= createCatalogLoader();
  return defaultLoader(key);
}
export function loadSavedCatalog(key: string | undefined): Promise<ResolvedExecutionCatalog> {
  const savedKey = key ?? process.env.CLOUD_LEGACY_CATALOG_KEY;
  if (!savedKey)
    throw new Error(
      "execution_catalog_unpinned: recover the original immutable catalog before replay or scoring",
    );
  return loadExecutionCatalog(savedKey);
}
export function captureCurrentCatalog(): Promise<ResolvedExecutionCatalog> {
  const key = currentCatalogKey();
  if (!key) throw new Error("Missing current execution catalog identity.");
  return loadExecutionCatalog(key);
}
export async function loadExecutionSourceBytes(
  catalog: ExecutionCatalog,
  problemId: string,
  relativePath: string,
): Promise<Uint8Array> {
  const ref = catalog.sources[problemId]?.[relativePath];
  if (!ref || ref.key !== `sources/${ref.digest}`)
    throw new Error("Pinned execution source is missing.");
  defaultObjects ??= createExecutionObjectLoader();
  return defaultObjects(ref.key);
}
export async function loadExecutionSourceText(
  catalog: ExecutionCatalog,
  problemId: string,
  relativePath: string,
): Promise<string> {
  return Buffer.from(await loadExecutionSourceBytes(catalog, problemId, relativePath)).toString(
    "utf8",
  );
}
export async function loadExecutionPluginSource(
  catalog: ExecutionCatalog,
  problemId: string,
): Promise<string> {
  const ref = catalog.plugins[problemId];
  if (!ref || ref.key !== `plugins/${ref.digest}.mjs`)
    throw new Error("Pinned execution plugin is missing.");
  defaultObjects ??= createExecutionObjectLoader();
  return Buffer.from(await defaultObjects(ref.key)).toString("utf8");
}
