import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { UnconfiguredCoordinationArtifactStore } from "../../lib/problem-deploy/control-data/coordination-artifact-store";
import {
  collectProjectedArtifactIds,
  coordinationScopePrefix,
  coordinationTombstoneKey,
} from "../../lib/problem-deploy/control-data/domain/coordination-artifact";
import type { CoordinationStateScope } from "../../lib/problem-deploy/control-data/domain/coordination-scope";
import { S3CoordinationArtifactStore } from "../../lib/problem-deploy/control-data/s3-coordination-artifact-store";
import {
  fetchAuthorizedArtifact,
  parseArtifactSubmissions,
  storeArtifactSubmissions,
  withArtifactRefs,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-artifacts";

/**
 * [Issue #3152] Immutable submissions move out of the state row.
 *
 * Two thirds of `ac26-crypto-battle`'s 99-team row is material nothing will ever
 * edit — proofs, leaked shares, transcripts — and every operation pays for it,
 * because the row is read, modified and written whole.
 *
 * The tests below are ordered the way the issue argues: the write side is the
 * easy half, the read path is the design, and the deletion race is the part
 * that has to be shown rather than asserted.
 */

const SCOPE: CoordinationStateScope = {
  tenantId: "tenant-a",
  eventId: "ev-1",
  problemId: "crypto-battle",
  runId: "default",
};

/**
 * An in-memory S3 that answers the four commands this store uses.
 *
 * The real adapter is exercised, not a stand-in for it: the tombstone protocol
 * IS the ordering of these calls, so a fake store that reimplemented it would
 * be testing the test.
 */
function makeFakeS3(): {
  readonly send: (command: unknown) => Promise<unknown>;
  readonly objects: Map<string, { body: Uint8Array; contentType: string }>;
  /** Runs on every command, so a test can interleave a delete with a put. */
  onCommand?: (command: unknown) => Promise<void> | void;
} {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();

  const handlePut = (command: PutObjectCommand): unknown => {
    const body = command.input.Body;
    objects.set(String(command.input.Key), {
      body: typeof body === "string" ? new TextEncoder().encode(body) : (body as Uint8Array),
      contentType: String(command.input.ContentType ?? "application/octet-stream"),
    });
    return {};
  };

  const handleGet = (command: GetObjectCommand): unknown => {
    const stored = objects.get(String(command.input.Key));
    if (!stored) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
    return {
      ContentType: stored.contentType,
      Metadata: {},
      Body: {
        transformToByteArray: () => Promise.resolve(stored.body),
        transformToString: () => Promise.resolve(new TextDecoder().decode(stored.body)),
      },
    };
  };

  const handleList = (command: ListObjectsV2Command): unknown => {
    const prefix = String(command.input.Prefix ?? "");
    return {
      Contents: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((Key) => ({ Key })),
    };
  };

  const handleDeleteMany = (command: DeleteObjectsCommand): unknown => {
    for (const object of command.input.Delete?.Objects ?? []) objects.delete(String(object.Key));
    return {};
  };

  const route = (command: unknown): unknown => {
    if (command instanceof PutObjectCommand) return handlePut(command);
    if (command instanceof GetObjectCommand) return handleGet(command);
    if (command instanceof ListObjectsV2Command) return handleList(command);
    if (command instanceof DeleteObjectsCommand) return handleDeleteMany(command);
    if (command instanceof DeleteObjectCommand) {
      objects.delete(String(command.input.Key));
      return {};
    }
    throw new Error(`unexpected S3 command: ${(command as object).constructor.name}`);
  };

  const fake = {
    objects,
    onCommand: undefined as ((command: unknown) => Promise<void> | void) | undefined,
    send: async (command: unknown): Promise<unknown> => {
      await fake.onCommand?.(command);
      return route(command);
    },
  };
  return fake;
}

function makeStore(
  fake: ReturnType<typeof makeFakeS3>,
  now: () => number = () => 1_700_000_000_000,
): S3CoordinationArtifactStore {
  let counter = 0;
  return new S3CoordinationArtifactStore({
    s3: fake as never,
    bucket: "artifacts",
    now,
    newArtifactId: () => `artifact${++counter}`,
  });
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("S3CoordinationArtifactStore (#3152)", () => {
  it("should store a body under the scope's prefix and issue a reference for it", async () => {
    const fake = makeFakeS3();
    const store = makeStore(fake);

    const outcome = await store.put(SCOPE, {
      contentType: "application/octet-stream",
      content: bytes("proof-bytes"),
    });

    expect(outcome.kind).toBe("stored");
    // The reference is what the plugin's state and its projections carry, so it
    // has to describe the body without being it.
    expect(outcome.kind === "stored" && outcome.ref).toMatchObject({
      artifactId: "artifact1",
      contentType: "application/octet-stream",
      bytes: 11,
    });
    expect([...fake.objects.keys()]).toEqual([`${coordinationScopePrefix(SCOPE)}artifact1`]);
  });

  it("should round-trip the exact bytes and a digest computed from them", async () => {
    const fake = makeFakeS3();
    const store = makeStore(fake);
    const stored = await store.put(SCOPE, { contentType: "text/plain", content: bytes("share-7") });
    const artifactId = stored.kind === "stored" ? stored.ref.artifactId : "";

    const fetched = await store.get(SCOPE, artifactId);

    expect(new TextDecoder().decode(fetched?.content)).toBe("share-7");
    // Recomputed on read rather than echoed from the object's own metadata: a
    // digest read out of the same response it is meant to check verifies
    // nothing.
    expect(fetched?.ref.digest).toBe(stored.kind === "stored" ? stored.ref.digest : "");
  });

  it("should report a missing artifact as absent rather than throwing", async () => {
    const store = makeStore(makeFakeS3());
    expect(await store.get(SCOPE, "never-written")).toBeUndefined();
  });

  it("should refuse a body above the per-artifact ceiling", async () => {
    const store = makeStore(makeFakeS3());
    // Without a ceiling a participant could push unbounded data through an
    // authenticated endpoint, and the platform could not say what a match costs
    // to store.
    await expect(
      store.put(SCOPE, {
        contentType: "application/octet-stream",
        content: new Uint8Array(2 * 1024 * 1024),
      }),
    ).rejects.toThrow(RangeError);
  });

  it("should refuse a scope whose components could reshape the key", async () => {
    const store = makeStore(makeFakeS3());
    // A component containing a slash would silently move the object into
    // another tenant's prefix, which is a cross-tenant read waiting to happen.
    await expect(
      store.put(
        { ...SCOPE, tenantId: "tenant-a/../tenant-b" },
        { contentType: "text/plain", content: bytes("x") },
      ),
    ).rejects.toThrow(RangeError);
  });
});

describe("deleting a scope, and the write that races it (#3152)", () => {
  it("should empty the prefix and leave the tombstone behind", async () => {
    const fake = makeFakeS3();
    const store = makeStore(fake);
    await store.put(SCOPE, { contentType: "text/plain", content: bytes("a") });
    await store.put(SCOPE, { contentType: "text/plain", content: bytes("b") });

    const removed = await store.deleteScope(SCOPE);

    expect(removed).toBe(2);
    // The tombstone is not swept with the rest: it is what a write still in
    // flight checks itself against.
    expect([...fake.objects.keys()]).toEqual([coordinationTombstoneKey(SCOPE)]);
  });

  it("should not touch another scope's artifacts", async () => {
    const fake = makeFakeS3();
    const store = makeStore(fake);
    const other = { ...SCOPE, problemId: "other-battle" };
    await store.put(SCOPE, { contentType: "text/plain", content: bytes("mine") });
    await store.put(other, { contentType: "text/plain", content: bytes("theirs") });

    await store.deleteScope(SCOPE);

    expect(fake.objects.has(`${coordinationScopePrefix(other)}artifact2`)).toBe(true);
  });

  it("should leave no orphan when a delete lands between a put's write and its check", async () => {
    // The interleaving the issue names: the sweep has already listed the prefix
    // when the body arrives, so nothing on the delete side will ever see this
    // object again.
    const fake = makeFakeS3();
    const writer = makeStore(fake, () => 1_000);
    const deleter = makeStore(fake, () => 2_000);
    let deleted = false;
    fake.onCommand = async (command) => {
      if (!deleted && command instanceof GetObjectCommand) {
        // The writer has stored its body and is now reading the tombstone. Run
        // the whole teardown right here.
        deleted = true;
        await deleter.deleteScope(SCOPE);
      }
    };

    const outcome = await writer.put(SCOPE, {
      contentType: "text/plain",
      content: bytes("in-flight"),
    });

    // The writer withdraws what it wrote, because the scope was deleted at an
    // instant at or after the one its own write began at.
    expect(outcome.kind).toBe("scope_deleted");
    expect([...fake.objects.keys()]).toEqual([coordinationTombstoneKey(SCOPE)]);
  });

  it("should keep a body submitted after the scope was deleted and restarted", async () => {
    // The other half of the same rule. A tombstone that voided the prefix
    // forever would poison a scope that legitimately starts over — which is
    // what a run reset does.
    const fake = makeFakeS3();
    await makeStore(fake, () => 1_000).deleteScope(SCOPE);
    const later = makeStore(fake, () => 5_000);

    const outcome = await later.put(SCOPE, {
      contentType: "text/plain",
      content: bytes("new match"),
    });

    expect(outcome.kind).toBe("stored");
    expect(fake.objects.has(`${coordinationScopePrefix(SCOPE)}artifact1`)).toBe(true);
  });
});

describe("artifact submission parsing (#3152)", () => {
  const submission = (over: Record<string, unknown> = {}) => ({
    proof: { contentType: "application/octet-stream", contentBase64: "aGk=", ...over },
  });

  it("should accept a well-formed submission", () => {
    const parsed = parseArtifactSubmissions(submission());
    expect(parsed.ok && parsed.submissions).toHaveLength(1);
    expect(parsed.ok && new TextDecoder().decode(parsed.submissions[0]?.content)).toBe("hi");
  });

  it("should treat an absent artifacts field as no artifacts", () => {
    // Most operations carry none, and they must not be made to say so.
    expect(parseArtifactSubmissions(undefined)).toEqual({ ok: true, submissions: [] });
  });

  it("should refuse rather than truncate every limit it enforces", () => {
    expect(parseArtifactSubmissions("not-an-object")).toMatchObject({ ok: false });
    expect(parseArtifactSubmissions({ "bad slot": submission().proof })).toMatchObject({
      ok: false,
      error: "invalid_artifact_slot",
    });
    expect(parseArtifactSubmissions(submission({ contentType: "not-a-media-type" }))).toMatchObject(
      {
        ok: false,
        error: "invalid_artifact_content_type",
      },
    );
    expect(
      parseArtifactSubmissions(
        Object.fromEntries(
          Array.from({ length: 9 }, (_, index) => [`slot${index}`, submission().proof]),
        ),
      ),
    ).toMatchObject({ ok: false, error: "too_many_artifacts" });
  });

  it("should reject invalid base64 instead of storing a shorter body", () => {
    // `Buffer.from(s, "base64")` skips what it does not recognise, so a corrupt
    // upload would decode to fewer bytes and be stored as though it were fine —
    // failing later against whatever the plugin checks it against, and looking
    // like a problem bug rather than a rejected upload.
    expect(parseArtifactSubmissions(submission({ contentBase64: "aG!k=" }))).toMatchObject({
      ok: false,
      error: "invalid_artifact_encoding",
    });
  });
});

describe("references reach the plugin, bodies do not (#3152)", () => {
  it("should hand the plugin references under the reserved key", async () => {
    const store = makeStore(makeFakeS3());
    const stored = await storeArtifactSubmissions(store, SCOPE, [
      { slot: "proof", contentType: "text/plain", content: bytes("p") },
    ]);
    expect(stored.kind).toBe("stored");

    const op = withArtifactRefs(
      { kind: "PROVE" },
      stored.kind === "stored" ? stored.refs : {},
    ) as Record<string, unknown>;

    // `applyOp` stays a pure function of (state, teamId, op): it receives a
    // description of the body, never the body and never a way to fetch one.
    expect(op.kind).toBe("PROVE");
    expect(op.artifacts).toMatchObject({ proof: { artifactId: "artifact1", bytes: 1 } });
    expect(JSON.stringify(op)).not.toContain("p".repeat(2));
  });

  it("should leave an op untouched when it carries no artifacts", () => {
    const op = { kind: "LEAK" };
    expect(withArtifactRefs(op, {})).toBe(op);
  });

  it("should withdraw everything already written when a later body fails", async () => {
    const fake = makeFakeS3();
    const store = makeStore(fake);
    let puts = 0;
    fake.onCommand = (command) => {
      if (command instanceof PutObjectCommand && ++puts === 2) {
        throw new Error("storage is having a day");
      }
    };

    await expect(
      storeArtifactSubmissions(store, SCOPE, [
        { slot: "first", contentType: "text/plain", content: bytes("1") },
        { slot: "second", contentType: "text/plain", content: bytes("2") },
      ]),
    ).rejects.toThrow("storage is having a day");

    // The operation never reached the state, so nothing references the first
    // body and no teardown would ever find it.
    fake.onCommand = undefined;
    expect([...fake.objects.keys()]).toEqual([]);
  });
});

describe("fetching a body is authorized by the projection (#3152)", () => {
  it("should return the body when the team's own projection references it", async () => {
    const store = makeStore(makeFakeS3());
    const stored = await store.put(SCOPE, {
      contentType: "text/plain",
      content: bytes("share-value"),
    });
    const artifactId = stored.kind === "stored" ? stored.ref.artifactId : "";
    // Shaped like a real ledger projection: the reference sits inside an entry
    // inside a list, which is why the walk is shape-agnostic.
    const projection = { publicLedger: [{ team: "b", share: { artifactId, bytes: 11 } }] };

    const outcome = await fetchAuthorizedArtifact(store, SCOPE, projection, artifactId);

    // This is what keeps HUNT working: the hunter fetches the bodies of the
    // shares they are actually hunting, at the moment they hunt.
    expect(outcome.kind).toBe("ok");
    expect(outcome.kind === "ok" && new TextDecoder().decode(outcome.artifact.content)).toBe(
      "share-value",
    );
  });

  it("should refuse a body this team's projection does not reference", async () => {
    const store = makeStore(makeFakeS3());
    const stored = await store.put(SCOPE, { contentType: "text/plain", content: bytes("secret") });
    const artifactId = stored.kind === "stored" ? stored.ref.artifactId : "";

    // The plugin already decides what each team may see. Reusing that decision
    // means the fetch endpoint cannot disagree with the board the participant
    // is looking at.
    const outcome = await fetchAuthorizedArtifact(store, SCOPE, { publicLedger: [] }, artifactId);
    expect(outcome).toEqual({ kind: "not_found" });
  });

  it("should answer identically for an unauthorized and a nonexistent artifact", async () => {
    const store = makeStore(makeFakeS3());
    // Telling the two apart would let a participant probe which artifact ids
    // exist in a match they cannot see.
    expect(await fetchAuthorizedArtifact(store, SCOPE, {}, "made-up")).toEqual({
      kind: "not_found",
    });
    expect(
      await fetchAuthorizedArtifact(store, SCOPE, { ref: { artifactId: "made-up" } }, "made-up"),
    ).toEqual({ kind: "not_found" });
  });

  it("should survive a cyclic or absurdly deep projection", () => {
    // A projection is plugin-defined data. A plugin that returns a cycle must
    // cost a bounded amount rather than the request.
    const cyclic: Record<string, unknown> = { artifactId: "a" };
    cyclic.self = cyclic;
    expect([...collectProjectedArtifactIds(cyclic)]).toEqual(["a"]);

    let deep: Record<string, unknown> = { artifactId: "buried" };
    for (let index = 0; index < 50; index += 1) deep = { child: deep };
    expect(collectProjectedArtifactIds(deep).has("buried")).toBe(false);
  });
});

describe("a deployment with no artifact bucket (#3152)", () => {
  it("should refuse to accept a body it cannot store", async () => {
    // Accepting and discarding would leave the plugin's state referencing
    // artifacts that were never stored — discovered mid-match, by a participant
    // fetching a proof that does not exist.
    await expect(new UnconfiguredCoordinationArtifactStore().put()).rejects.toThrow(
      /COORDINATION_ARTIFACT_BUCKET/,
    );
  });

  it("should let teardown proceed rather than blocking it over a bucket nobody configured", async () => {
    const store = new UnconfiguredCoordinationArtifactStore();
    expect(await store.deleteScope()).toBe(0);
    expect(await store.get()).toBeUndefined();
    await expect(store.remove()).resolves.toBeUndefined();
  });
});
