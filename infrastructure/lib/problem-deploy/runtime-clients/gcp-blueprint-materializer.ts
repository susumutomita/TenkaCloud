/**
 * [Issue #2745] Materialize a GCP problem's Terraform source into an immutable `gs://`
 * object Infrastructure Manager can read.
 *
 * `gcp-infra-manager-adapter.ts` used to pass `runtime.entry` (a repository-relative path, e.g.
 * `targets/gcp`) straight through as `blueprintRef`. The REST client's `assertGcsBlueprintRef`
 * fail-closed guard always rejected that (correctly — it is not a `gs://` object), so no GCP
 * deploy could ever reach Infra Manager. This module is the missing INPUT-side step: resolve the
 * problem's Terraform root module (public materialized tree OR private payload zip — the same two
 * sources `create-stack.ts` / `challenge-payload-artifacts.ts` already read for AWS), zip it
 * deterministically, and upload it to a competitor-owned GCS bucket over plain `fetch` with the
 * same WIF-minted access token the Infra Manager REST client already uses (no service-account key,
 * no new SDK dependency — mirrors the existing `runtime-clients/*-rest-client.ts` wire-only style).
 *
 * ## Source resolution (fail-closed, no silent fallback)
 *
 *   - **Private** problem (`source.challengePayloadUrl` set): download + unzip the presigned
 *     `payload.zip` via {@link fetchChallengePayloadDirectory}, which shares the same zip-bomb
 *     bounds as the AWS `template.yaml`/`metadata.json` reader.
 *   - **Public** problem (`deps.s3` + `deps.sourceBucketName` wired): read every object under the
 *     materialized `problems/` tree at `{problemDir}/{entry}/` (a directory module) — or the single
 *     object at `{problemDir}/{entry}` (a one-file module) when no directory listing matches.
 *   - Neither configured → throws before any I/O (an operator-visible wiring gap, not a stub).
 *
 * `entry` is validated as a relative, non-traversal path before any provider call (defense in
 * depth; the pack SDK already rejects `..` at author time, this is the runtime-side backstop).
 *
 * ## Archive determinism
 *
 * {@link buildDeterministicBlueprintZip} sorts entries by path and pins a fixed `mtime` on every
 * entry (fflate defaults to `Date.now()`, which would make identical Terraform source hash
 * differently build-to-build) so the SAME source always produces the SAME zip bytes → the SAME
 * content-hash object key (see below) → an idempotent, cacheable upload.
 *
 * ## Upload + idempotency
 *
 * The object key is content-addressed and tenant/team/problem-scoped:
 * `tenkacloud/{tenantId}/{teamSlug}/{problemId}/{sha256(zip)}.zip`. Upload uses GCS's JSON API
 * `ifGenerationMatch=0` precondition (create-only). A `412 Precondition Failed` means the exact
 * same bytes are already there (a prior deploy, or a race with a concurrent one) — the object is
 * immutable and content-identical, so this branch GETs the existing object's `generation` and
 * reuses it rather than treating the conflict as an error. Any other non-2xx is a loud failure.
 *
 * Returns `gs://{bucket}/{key}#{generation}` — `gcp-infra-manager-rest-client.ts`'s
 * `assertGcsBlueprintRef` already accepts this form (`new URL(...)` parses the `#generation`
 * suffix as `.hash`, leaving `.protocol`/`.hostname`/`.pathname` untouched), so no guard change
 * was needed; see `gcp-infra-manager-rest-client.test.ts` for the pinned `#123`-suffixed case.
 *
 * ## Retention (documented, not automated)
 *
 * Objects are small (a Terraform root module, typically a few KB) and content-addressed, so the
 * same source across repeated deploys reuses one object instead of growing unbounded. There is no
 * automatic deletion on `destroy()`: the object may still be referenced by another team's identical
 * problem source (content-addressing is bucket-wide, not per-team), and Infra Manager itself may
 * still reference the blueprint for its deployment history after the deployment is torn down.
 * Operators wanting bounded storage should set a GCS Object Lifecycle Management rule on the
 * `artifactBucket` (age-based expiry) — a bucket-level competitor-owned setting, not something this
 * platform's CDK can express (the bucket is not platform infrastructure).
 */

import { createHash } from "node:crypto";
import type { S3Client } from "@aws-sdk/client-s3";
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { type ZipOptions, zipSync } from "fflate";
import { StatusCodes } from "http-status-codes";
import {
  type ChallengePayloadDirectoryFile,
  fetchChallengePayloadDirectory,
} from "../challenge-payload-artifacts.js";

/** One file of a Terraform root module, path-relative to that module's own root. */
export interface TerraformSourceFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

/** Where to read a GCP problem's Terraform root module from. */
export interface GcpBlueprintSource {
  /** `problems/<category>/<id>` — the materialized-tree prefix (public-problem path only). */
  readonly problemDir: string;
  /** `runtime.entry` (or a composite target's `entry`) — relative to `problemDir`. */
  readonly entry: string;
  /** presigned payload.zip URL for a private problem. Takes priority when set. */
  readonly challengePayloadUrl?: string;
}

export interface MaterializeGcpBlueprintArgs {
  readonly tenantId: string;
  readonly teamSlug: string;
  readonly problemId: string;
  readonly source: GcpBlueprintSource;
  /** WIF-minted short-lived access token — the SAME one the Infra Manager REST call uses. */
  readonly accessToken: string;
  /** Competitor-owned GCS bucket the team registered (`GcpDeployCredential.artifactBucket`). */
  readonly artifactBucket: string | undefined;
}

export interface GcpBlueprintMaterializerDeps {
  /** Public-problem path: S3 client scoped to the materialized `problems/` tree. */
  readonly s3?: Pick<S3Client, "send">;
  /** Public-problem path: the materialized-tree bucket name (`SOURCE_BUCKET_NAME`). */
  readonly sourceBucketName?: string;
  /** Private-problem path override (tests inject a fake; defaults to the real bounded fetch+unzip). */
  readonly fetchPayloadDirectory?: (
    url: string,
    entryDir: string,
  ) => Promise<readonly ChallengePayloadDirectoryFile[]>;
  /** GCS upload fetch override (tests inject a fake; defaults to global `fetch`). */
  readonly fetchImpl?: typeof fetch;
}

/** Reject an absolute path, a `..` segment, or a backslash BEFORE any I/O (defense in depth). */
function assertRelativeEntry(entry: string): void {
  if (
    entry.length === 0 ||
    entry.startsWith("/") ||
    entry.includes("\\") ||
    entry.split("/").includes("..")
  ) {
    throw new Error(`GCP blueprint entry '${entry}' is not a valid relative path`);
  }
}

async function getS3Bytes(
  s3: Pick<S3Client, "send">,
  bucket: string,
  key: string,
): Promise<Uint8Array> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = out.Body;
  if (
    !body ||
    typeof (body as { transformToByteArray?: unknown }).transformToByteArray !== "function"
  ) {
    throw new Error(`empty or unreadable S3 object: s3://${bucket}/${key}`);
  }
  return (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
}

/**
 * Public-problem path: read the Terraform root module from the materialized `problems/` tree.
 * Tries a directory listing at `{problemDir}/{entry}/` first (a multi-file module); if nothing
 * matches, falls back to a single object at `{problemDir}/{entry}` (a one-file module). Neither
 * present → fail loud with an actionable, non-secret diagnostic (never a silently empty archive).
 *
 * NOTE: `ListObjectsV2Command` is not paginated here — a Terraform root module for a competition
 * problem is a handful of files, well under one S3 listing page (1000 keys).
 */
async function resolveFromMaterializedTree(
  s3: Pick<S3Client, "send">,
  sourceBucketName: string,
  problemDir: string,
  entry: string,
): Promise<readonly TerraformSourceFile[]> {
  const prefix = `${problemDir}/${entry}`;
  const listed = await s3.send(
    new ListObjectsV2Command({ Bucket: sourceBucketName, Prefix: `${prefix}/` }),
  );
  const keys = (listed.Contents ?? [])
    .map((object) => object.Key)
    .filter((key): key is string => typeof key === "string" && !key.endsWith("/"));

  if (keys.length > 0) {
    const files = await Promise.all(
      keys.map(async (key) => ({
        relativePath: key.slice(prefix.length + 1),
        bytes: await getS3Bytes(s3, sourceBucketName, key),
      })),
    );
    return files;
  }

  try {
    const bytes = await getS3Bytes(s3, sourceBucketName, prefix);
    return [{ relativePath: entry.split("/").pop() ?? entry, bytes }];
  } catch {
    throw new Error(
      `GCP Terraform source not found: no object(s) under s3://${sourceBucketName}/${prefix} ` +
        "(the materialized problems/ tree requires CDK_PARAM_DEPLOY_VIA_LAMBDA=true, or deploy " +
        "this problem as a private problem instead)",
    );
  }
}

/**
 * Resolve a GCP problem's Terraform root module files. Private (`challengePayloadUrl` set) takes
 * priority over public (materialized tree); neither configured is a fail-closed wiring error, not
 * a silent empty result.
 */
export async function resolveGcpTerraformSource(
  source: GcpBlueprintSource,
  deps: GcpBlueprintMaterializerDeps,
): Promise<readonly TerraformSourceFile[]> {
  assertRelativeEntry(source.entry);
  if (source.challengePayloadUrl) {
    const fetchPayloadDirectory = deps.fetchPayloadDirectory ?? fetchChallengePayloadDirectory;
    return fetchPayloadDirectory(source.challengePayloadUrl, source.entry);
  }
  if (deps.s3 && deps.sourceBucketName) {
    return resolveFromMaterializedTree(
      deps.s3,
      deps.sourceBucketName,
      source.problemDir,
      source.entry,
    );
  }
  throw new Error(
    "GCP Terraform source is unavailable: neither a private challengePayloadUrl nor a " +
      "materialized source bucket (SOURCE_BUCKET_NAME) is configured for this deploy",
  );
}

/**
 * Fixed zip-entry mtime for determinism. The zip (MS-DOS date/time) format only represents years
 * 1980-2099, so `0` (epoch, 1970) is out of range for fflate — the earliest representable instant
 * is used instead. The value itself is arbitrary; what matters is that it never varies build-to-build.
 */
const FIXED_ZIP_MTIME = new Date("1980-01-01T00:00:00.000Z");

/**
 * Deterministic zip of a Terraform root module: sorted entry paths + a pinned `mtime`/`level` on
 * every entry (fflate defaults `mtime` to `Date.now()`, which would make byte-identical source
 * hash differently build-to-build) so the SAME files always produce the SAME zip bytes.
 */
export function buildDeterministicBlueprintZip(files: readonly TerraformSourceFile[]): Uint8Array {
  if (files.length === 0) {
    throw new Error("cannot build a GCP Terraform blueprint zip from zero files");
  }
  const sorted = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const data: Record<string, [Uint8Array, ZipOptions]> = {};
  for (const file of sorted) {
    data[file.relativePath] = [file.bytes, { mtime: FIXED_ZIP_MTIME, level: 6 }];
  }
  return zipSync(data, { mtime: FIXED_ZIP_MTIME, level: 6 });
}

/** Content-addressed, tenant/team/problem-scoped object key for a materialized blueprint zip. */
export function computeBlueprintObjectKey(args: {
  readonly tenantId: string;
  readonly teamSlug: string;
  readonly problemId: string;
  readonly zipBytes: Uint8Array;
}): string {
  const digest = createHash("sha256").update(args.zipBytes).digest("hex");
  return `tenkacloud/${args.tenantId}/${args.teamSlug}/${args.problemId}/${digest}.zip`;
}

interface GcsObjectMetadata {
  readonly generation?: string | number;
}

function requireGeneration(body: GcsObjectMetadata, operation: string): string {
  if (body.generation === undefined) {
    throw new Error(`GCS blueprint ${operation} response is missing 'generation'`);
  }
  return String(body.generation);
}

/**
 * Upload the zip as a NEW immutable object (`ifGenerationMatch=0`); on `412 Precondition Failed`
 * (content-addressed key already exists — a prior deploy or a concurrent race) GET the existing
 * object's `generation` and reuse it instead of treating the conflict as a failure.
 */
async function uploadOrReuseBlueprint(args: {
  readonly artifactBucket: string;
  readonly objectKey: string;
  readonly zipBytes: Uint8Array;
  readonly accessToken: string;
  readonly fetchImpl: typeof fetch;
}): Promise<string> {
  const bucket = encodeURIComponent(args.artifactBucket);
  const object = encodeURIComponent(args.objectKey);
  const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${object}&ifGenerationMatch=0`;

  const uploadRes = await args.fetchImpl(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/zip",
    },
    body: args.zipBytes,
  });

  if (uploadRes.status === StatusCodes.PRECONDITION_FAILED) {
    const getUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${object}`;
    const getRes = await args.fetchImpl(getUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${args.accessToken}` },
    });
    if (!getRes.ok) {
      throw new Error(
        `GCS blueprint reuse GET failed: ${getRes.status} ${await getRes.text().catch(() => "")}`.trim(),
      );
    }
    return requireGeneration((await getRes.json()) as GcsObjectMetadata, "reuse");
  }
  if (!uploadRes.ok) {
    throw new Error(
      `GCS blueprint upload failed: ${uploadRes.status} ${await uploadRes.text().catch(() => "")}`.trim(),
    );
  }
  return requireGeneration((await uploadRes.json()) as GcsObjectMetadata, "upload");
}

/**
 * Materialize a GCP problem's Terraform source into an immutable `gs://` object and return the
 * blueprint reference `gcp-infra-manager-rest-client.ts` requires. See the module docblock for the
 * full source-resolution / determinism / idempotency / retention rationale.
 */
export async function materializeGcpBlueprint(
  args: MaterializeGcpBlueprintArgs,
  deps: GcpBlueprintMaterializerDeps = {},
): Promise<string> {
  if (!args.artifactBucket) {
    throw new Error(
      `no GCS artifactBucket registered for tenant ${args.tenantId} team ${args.teamSlug} ` +
        "(register artifactBucket in the team's GCP connection before deploying a gcp/infra-manager problem)",
    );
  }
  const files = await resolveGcpTerraformSource(args.source, deps);
  const zipBytes = buildDeterministicBlueprintZip(files);
  const objectKey = computeBlueprintObjectKey({
    tenantId: args.tenantId,
    teamSlug: args.teamSlug,
    problemId: args.problemId,
    zipBytes,
  });
  const generation = await uploadOrReuseBlueprint({
    artifactBucket: args.artifactBucket,
    objectKey,
    zipBytes,
    accessToken: args.accessToken,
    fetchImpl: deps.fetchImpl ?? fetch,
  });
  return `gs://${args.artifactBucket}/${objectKey}#${generation}`;
}
