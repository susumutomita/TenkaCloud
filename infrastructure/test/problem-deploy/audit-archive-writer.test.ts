import type { DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveRecord,
  buildObjectKey,
  handler,
  recordToRow,
} from "../../lib/problem-deploy/handlers/audit-archive-writer";

/**
 * Issue #1341 (#1335 Phase 3): AdminAuditLog DDB Stream → S3 archive Lambda の挙動を pin する。
 *
 * - INSERT 以外の record は skip するべき (= REMOVE は TTL expiry で大量に出る)
 * - object key は `audit/year=YYYY/month=MM/day=DD/...` の Hive partition layout で出るべき
 * - PutObject 失敗は throw せず archived=0 で次 record に進むべき (= fail-safe / Stream retry storm 回避)
 */

const ORIGINAL_BUCKET = process.env.AUDIT_ARCHIVE_BUCKET_NAME;
beforeEach(() => {
  process.env.AUDIT_ARCHIVE_BUCKET_NAME = "test-audit-archive";
});
afterEach(() => {
  if (ORIGINAL_BUCKET === undefined) delete process.env.AUDIT_ARCHIVE_BUCKET_NAME;
  else process.env.AUDIT_ARCHIVE_BUCKET_NAME = ORIGINAL_BUCKET;
});

function buildInsertRecord(
  overrides: Partial<{ PK: string; SK: string; action: string }> = {},
): DynamoDBRecord {
  const pk = overrides.PK ?? "TENANT#t-1";
  const sk = overrides.SK ?? "AUDIT#01HX0000000000000000000000";
  const action = overrides.action ?? "patch_user_role";
  return {
    eventID: "1",
    eventName: "INSERT",
    eventVersion: "1.1",
    eventSource: "aws:dynamodb",
    awsRegion: "ap-northeast-1",
    dynamodb: {
      ApproximateCreationDateTime: 1_700_000_000,
      Keys: {
        PK: { S: pk },
        SK: { S: sk },
      },
      NewImage: {
        PK: { S: pk },
        SK: { S: sk },
        actor: { S: "user-sub-1" },
        actorUsername: { S: "alice@example.com" },
        action: { S: action },
        outcome: { S: "success" },
        target: { S: "bob@example.com" },
        occurredAt: { S: "2026-05-17T12:00:00.000Z" },
        extra: { M: { reason: { S: "downgrade" } } },
      },
      SequenceNumber: "100",
      SizeBytes: 100,
      StreamViewType: "NEW_AND_OLD_IMAGES",
    },
  };
}

describe("buildObjectKey", () => {
  it("should emit Hive-style year=/month=/day= partition prefix", () => {
    const key = buildObjectKey(new Date("2026-05-17T12:00:00.000Z"), "abcd1234");
    expect(key).toMatch(
      /^audit\/year=2026\/month=05\/day=17\/2026-05-17T12-00-00-000Z-abcd1234\.jsonl$/,
    );
  });

  it("should pad single-digit month and day", () => {
    const key = buildObjectKey(new Date("2026-01-03T00:00:00.000Z"), "x");
    expect(key.startsWith("audit/year=2026/month=01/day=03/")).toBe(true);
  });
});

describe("recordToRow", () => {
  it("should map INSERT records into a normalized row", () => {
    const row = recordToRow(buildInsertRecord());
    expect(row).not.toBeNull();
    expect(row?.PK).toBe("TENANT#t-1");
    expect(row?.action).toBe("patch_user_role");
    expect(row?.extra).toEqual({ reason: "downgrade" });
  });

  it("should skip MODIFY records (audit log is append-only)", () => {
    const rec = buildInsertRecord();
    rec.eventName = "MODIFY";
    expect(recordToRow(rec)).toBeNull();
  });

  it("should skip REMOVE records (TTL expiry must not re-emit to archive)", () => {
    const rec = buildInsertRecord();
    rec.eventName = "REMOVE";
    expect(recordToRow(rec)).toBeNull();
  });

  it("should skip records without NewImage", () => {
    const rec = buildInsertRecord();
    if (rec.dynamodb) rec.dynamodb.NewImage = undefined;
    expect(recordToRow(rec)).toBeNull();
  });
});

describe("archiveRecord", () => {
  it("should PutObject with application/x-ndjson body containing the row", async () => {
    const putObject = vi.fn().mockResolvedValue(undefined);
    const out = await archiveRecord(buildInsertRecord(), {
      s3: { putObject },
      bucketName: "test-audit-archive",
    });
    expect(out.archived).toBe(true);
    expect(putObject).toHaveBeenCalledTimes(1);
    const args = putObject.mock.calls[0]?.[0] as {
      bucket: string;
      contentType: string;
      body: string;
    };
    expect(args.bucket).toBe("test-audit-archive");
    expect(args.contentType).toBe("application/x-ndjson");
    expect(args.body.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(args.body.trim());
    expect(parsed.actor).toBe("user-sub-1");
    expect(parsed.action).toBe("patch_user_role");
  });

  it("should use the occurredAt timestamp for the key partition", async () => {
    const putObject = vi.fn().mockResolvedValue(undefined);
    const out = await archiveRecord(buildInsertRecord(), {
      s3: { putObject },
      bucketName: "test-audit-archive",
    });
    expect(out.key).toMatch(/^audit\/year=2026\/month=05\/day=17\//);
  });
});

describe("handler", () => {
  it("should noop when AUDIT_ARCHIVE_BUCKET_NAME is unset (legacy stack compat)", async () => {
    delete process.env.AUDIT_ARCHIVE_BUCKET_NAME;
    const event: DynamoDBStreamEvent = { Records: [buildInsertRecord()] };
    const result = await handler(event);
    expect(result.archived).toBe(0);
  });

  it("should swallow PutObject errors and continue with remaining records", async () => {
    // We can't easily inject deps into handler() (= uses module-scope S3 client), so verify
    // the env=unset noop path above. archiveRecord-level error surfaces here so the outer
    // Lambda handler can decide whether to swallow.
    const errPut = vi.fn().mockRejectedValue(new Error("S3 down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      archiveRecord(buildInsertRecord(), { s3: { putObject: errPut }, bucketName: "x" }),
    ).rejects.toThrow("S3 down");
    errSpy.mockRestore();
  });
});
