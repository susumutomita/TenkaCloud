import { createHash, randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type {
  CoordinationArtifactFetch,
  CoordinationArtifactPutOutcome,
  CoordinationArtifactStore,
} from "./coordination-artifact-store.js";
import {
  COORDINATION_ARTIFACT_MAX_BYTES,
  type CoordinationArtifactBody,
  type CoordinationArtifactRef,
  type CoordinationArtifactTombstone,
  coordinationArtifactKey,
  coordinationScopePrefix,
  coordinationTombstoneKey,
} from "./domain/coordination-artifact.js";
import type { CoordinationStateScope } from "./domain/coordination-scope.js";

/**
 * [Issue #3152] S3-backed {@link CoordinationArtifactStore}.
 *
 * ## The ordering that keeps a deleted scope empty
 *
 * Two operations race: a participant submitting a body, and a teardown removing
 * the scope. The dangerous interleaving is the write landing after the sweep
 * has listed the prefix, leaving an object nothing references and nothing will
 * ever remove.
 *
 * Neither side is ordered against the other directly. Instead both are ordered
 * against the tombstone:
 *
 *   - {@link deleteScope} writes the tombstone FIRST, then sweeps. Anything the
 *     sweep sees, it removes.
 *   - {@link put} records the instant it began, writes the body, and then reads
 *     the tombstone. If the scope was deleted at or after that instant, the
 *     writer removes its own object and reports `scope_deleted`.
 *
 * Every interleaving therefore ends with the prefix empty: an object written
 * before the sweep is swept, and one written after it is withdrawn by its own
 * writer, because a sweep that missed it can only have happened after the
 * tombstone that its writer then reads.
 *
 * The remaining exposure is clock skew between the two callers, and it is
 * one-sided by construction: a writer whose clock runs behind withdraws a body
 * it could have kept (the participant sees the match as ended, which it is),
 * while only a writer whose clock runs far ahead of the deleter could keep one.
 * Both sides are Lambdas in one account, and the alternative — a coordination
 * lock across an object store — would cost every submission a round trip to
 * remove a failure mode that empties itself at the bucket's expiry anyway.
 */
export interface S3CoordinationArtifactStoreDeps {
  readonly s3: Pick<S3Client, "send">;
  readonly bucket: string;
  /** Injected for tests; production passes nothing and gets the real clock. */
  readonly now?: () => number;
  /** Injected for tests; production passes nothing and gets `randomUUID`. */
  readonly newArtifactId?: () => string;
}

/** S3 deletes at most 1000 keys per `DeleteObjects` call. */
const DELETE_BATCH_SIZE = 1000;

export class S3CoordinationArtifactStore implements CoordinationArtifactStore {
  private readonly s3: Pick<S3Client, "send">;
  private readonly bucket: string;
  private readonly now: () => number;
  private readonly newArtifactId: () => string;

  constructor(deps: S3CoordinationArtifactStoreDeps) {
    this.s3 = deps.s3;
    this.bucket = deps.bucket;
    this.now = deps.now ?? (() => Date.now());
    this.newArtifactId = deps.newArtifactId ?? (() => randomUUID().replaceAll("-", ""));
  }

  async put(
    scope: CoordinationStateScope,
    body: CoordinationArtifactBody,
  ): Promise<CoordinationArtifactPutOutcome> {
    if (body.content.byteLength > COORDINATION_ARTIFACT_MAX_BYTES) {
      throw new RangeError(
        `coordination artifact is ${body.content.byteLength} bytes, above the ${COORDINATION_ARTIFACT_MAX_BYTES}-byte limit`,
      );
    }
    // Taken before the write, not after: this is the instant the submission
    // began, and it is what a later tombstone is compared against.
    const writtenAtMs = this.now();
    const artifactId = this.newArtifactId();
    const ref: CoordinationArtifactRef = {
      artifactId,
      contentType: body.contentType,
      bytes: body.content.byteLength,
      digest: createHash("sha256").update(body.content).digest("hex"),
      writtenAtMs,
    };
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: coordinationArtifactKey(scope, artifactId),
        Body: body.content,
        ContentType: body.contentType,
        // Carried on the object as well as in the plugin's state so an operator
        // reading the bucket can tell what an object is without the row, and so
        // a fetch can answer without a second lookup.
        Metadata: {
          digest: ref.digest,
          writtenat: String(writtenAtMs),
        },
      }),
    );
    const tombstone = await this.readTombstone(scope);
    if (tombstone && tombstone.deletedAtMs >= writtenAtMs) {
      // The scope was torn down while this body was in flight. Withdraw it: the
      // sweep may already have passed this key, and an object nothing
      // references is exactly the orphan this protocol exists to prevent.
      await this.remove(scope, artifactId);
      return { kind: "scope_deleted" };
    }
    return { kind: "stored", ref };
  }

  async get(
    scope: CoordinationStateScope,
    artifactId: string,
  ): Promise<CoordinationArtifactFetch | undefined> {
    let response: unknown;
    try {
      response = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: coordinationArtifactKey(scope, artifactId),
        }),
      );
    } catch (err) {
      if (isNoSuchKey(err)) return undefined;
      throw err;
    }
    const output = response as {
      readonly Body?: { transformToByteArray?: () => Promise<Uint8Array> };
      readonly ContentType?: string;
      readonly Metadata?: Record<string, string>;
    };
    const content = (await output.Body?.transformToByteArray?.()) ?? new Uint8Array();
    return {
      content,
      ref: {
        artifactId,
        contentType: output.ContentType ?? "application/octet-stream",
        bytes: content.byteLength,
        // Recomputed rather than trusted from metadata: the digest's only job is
        // to let a reader verify the bytes it just received, and a digest read
        // out of the same response it is meant to check verifies nothing.
        digest: createHash("sha256").update(content).digest("hex"),
        writtenAtMs: Number(output.Metadata?.writtenat ?? 0),
      },
    };
  }

  async remove(scope: CoordinationStateScope, artifactId: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: coordinationArtifactKey(scope, artifactId),
      }),
    );
  }

  async deleteScope(scope: CoordinationStateScope): Promise<number> {
    const deletedAtMs = this.now();
    const tombstone: CoordinationArtifactTombstone = { deletedAtMs };
    // The tombstone goes first. A sweep that ran before it would leave any
    // in-flight write with nothing to check itself against.
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: coordinationTombstoneKey(scope),
        Body: JSON.stringify(tombstone),
        ContentType: "application/json",
      }),
    );

    const prefix = coordinationScopePrefix(scope);
    const tombstoneKey = coordinationTombstoneKey(scope);
    let removed = 0;
    let continuationToken: string | undefined;
    do {
      const page = (await (this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      ) as unknown)) as {
        readonly Contents?: readonly { readonly Key?: string }[];
        readonly NextContinuationToken?: string;
      };
      const keys = (page.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => typeof key === "string" && key !== tombstoneKey);
      for (let index = 0; index < keys.length; index += DELETE_BATCH_SIZE) {
        const batch = keys.slice(index, index + DELETE_BATCH_SIZE);
        await this.s3.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })) },
          }),
        );
        removed += batch.length;
      }
      continuationToken = page.NextContinuationToken;
    } while (continuationToken);
    return removed;
  }

  private async readTombstone(
    scope: CoordinationStateScope,
  ): Promise<CoordinationArtifactTombstone | undefined> {
    let response: unknown;
    try {
      response = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: coordinationTombstoneKey(scope) }),
      );
    } catch (err) {
      if (isNoSuchKey(err)) return undefined;
      throw err;
    }
    const body = await (
      response as { readonly Body?: { transformToString?: () => Promise<string> } }
    ).Body?.transformToString?.();
    if (!body) return undefined;
    try {
      const parsed = JSON.parse(body) as Partial<CoordinationArtifactTombstone>;
      return typeof parsed.deletedAtMs === "number"
        ? { deletedAtMs: parsed.deletedAtMs }
        : undefined;
    } catch {
      // A tombstone we cannot read is treated as absent rather than as a
      // deletion. Refusing every write on an unparseable marker would take a
      // whole match down over a corrupt 20-byte object; the sweep is still the
      // primary path and the bucket's expiry is still the backstop.
      return undefined;
    }
  }
}

/** S3 signals a missing key with either of these, depending on the operation. */
function isNoSuchKey(err: unknown): boolean {
  const name = (err as { name?: string; Code?: string } | undefined)?.name;
  const code = (err as { Code?: string } | undefined)?.Code;
  return name === "NoSuchKey" || name === "NotFound" || code === "NoSuchKey";
}
