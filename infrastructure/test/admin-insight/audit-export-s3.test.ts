import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import {
  dayPartitions,
  exportAuditArchive,
  isValidDate,
  MAX_EXPORT_BYTES,
} from "../../lib/admin-insight/handlers/admin-insight-handler/audit-export-s3";

/**
 * Issue #1341 (#1335 Phase 3): immutable S3 archive 経路の export 挙動を pin する。
 *
 * - dayPartitions は YYYY-MM-DD 範囲を Hive partition prefix の配列に展開する
 * - 100MB を超えるデータは truncated=true で打ち切られる
 * - ListObjectsV2 → GetObject の順で blob を結合した JSONL を返す
 */

describe("isValidDate", () => {
  it("should accept YYYY-MM-DD", () => {
    expect(isValidDate("2026-05-24")).toBe(true);
  });
  it("should reject malformed dates", () => {
    expect(isValidDate("2026/05/24")).toBe(false);
    expect(isValidDate("abc")).toBe(false);
    expect(isValidDate("")).toBe(false);
  });
});

describe("dayPartitions", () => {
  it("should enumerate inclusive day prefixes for a single day", () => {
    const out = dayPartitions({ from: "2026-05-24", to: "2026-05-24" });
    expect(out).toEqual(["audit/year=2026/month=05/day=24/"]);
  });

  it("should enumerate inclusive day prefixes spanning month boundaries", () => {
    const out = dayPartitions({ from: "2026-04-30", to: "2026-05-02" });
    expect(out).toEqual([
      "audit/year=2026/month=04/day=30/",
      "audit/year=2026/month=05/day=01/",
      "audit/year=2026/month=05/day=02/",
    ]);
  });

  it("should return empty when from > to", () => {
    expect(dayPartitions({ from: "2026-05-10", to: "2026-05-01" })).toEqual([]);
  });

  it("should return empty for invalid dates", () => {
    expect(dayPartitions({ from: "x", to: "y" })).toEqual([]);
  });
});

describe("exportAuditArchive", () => {
  function buildSend(plan: {
    listResponses: Array<{
      Contents?: Array<{ Key?: string }>;
      IsTruncated?: boolean;
      NextContinuationToken?: string;
    }>;
    getResponses: Record<string, string>;
  }): ReturnType<typeof vi.fn> {
    let listIdx = 0;
    return vi.fn(async (cmd: unknown) => {
      if (cmd instanceof ListObjectsV2Command) {
        const r = plan.listResponses[listIdx] ?? { Contents: [] };
        listIdx += 1;
        return r;
      }
      if (cmd instanceof GetObjectCommand) {
        const input = (cmd as { input: { Key: string } }).input;
        const content = plan.getResponses[input.Key] ?? "";
        return { Body: { transformToString: async () => content } };
      }
      return {};
    });
  }

  it("should concatenate JSONL objects across day partitions", async () => {
    const send = buildSend({
      listResponses: [
        { Contents: [{ Key: "audit/year=2026/month=05/day=24/a.jsonl" }] },
        { Contents: [{ Key: "audit/year=2026/month=05/day=25/b.jsonl" }] },
      ],
      getResponses: {
        "audit/year=2026/month=05/day=24/a.jsonl": '{"id":1}\n',
        "audit/year=2026/month=05/day=25/b.jsonl": '{"id":2}\n',
      },
    });
    const out = await exportAuditArchive(
      { s3: { send: send as never }, bucketName: "test-bucket" },
      { from: "2026-05-24", to: "2026-05-25" },
    );
    expect(out.objectCount).toBe(2);
    expect(out.truncated).toBe(false);
    expect(out.body).toBe('{"id":1}\n{"id":2}\n');
  });

  it("should truncate when the cumulative bytes exceed MAX_EXPORT_BYTES", async () => {
    // Build a single huge response that exceeds the cap so the cap branch is exercised.
    const big = "x".repeat(MAX_EXPORT_BYTES + 1024);
    const send = buildSend({
      listResponses: [
        {
          Contents: [
            { Key: "audit/year=2026/month=05/day=24/a.jsonl" },
            { Key: "audit/year=2026/month=05/day=24/b.jsonl" },
          ],
        },
      ],
      getResponses: {
        "audit/year=2026/month=05/day=24/a.jsonl": big,
        "audit/year=2026/month=05/day=24/b.jsonl": "should-not-be-included",
      },
    });
    const out = await exportAuditArchive(
      { s3: { send: send as never }, bucketName: "test-bucket" },
      { from: "2026-05-24", to: "2026-05-24" },
    );
    expect(out.truncated).toBe(true);
    // The "a" object should be skipped because it alone exceeds the cap (= cap branch reached
    // before any content concatenation for it).
    expect(out.body).toBe("");
    expect(out.objectCount).toBe(0);
  });

  it("should follow ListObjectsV2 pagination via ContinuationToken", async () => {
    const send = buildSend({
      listResponses: [
        {
          Contents: [{ Key: "audit/year=2026/month=05/day=24/a.jsonl" }],
          IsTruncated: true,
          NextContinuationToken: "next",
        },
        { Contents: [{ Key: "audit/year=2026/month=05/day=24/b.jsonl" }] },
      ],
      getResponses: {
        "audit/year=2026/month=05/day=24/a.jsonl": '{"a":1}\n',
        "audit/year=2026/month=05/day=24/b.jsonl": '{"b":2}\n',
      },
    });
    const out = await exportAuditArchive(
      { s3: { send: send as never }, bucketName: "test-bucket" },
      { from: "2026-05-24", to: "2026-05-24" },
    );
    expect(out.objectCount).toBe(2);
    expect(out.body).toBe('{"a":1}\n{"b":2}\n');
  });

  it("should return empty result when partitions are empty", async () => {
    const send = buildSend({ listResponses: [{ Contents: [] }], getResponses: {} });
    const out = await exportAuditArchive(
      { s3: { send: send as never }, bucketName: "test-bucket" },
      { from: "2026-05-24", to: "2026-05-24" },
    );
    expect(out.body).toBe("");
    expect(out.objectCount).toBe(0);
    expect(out.truncated).toBe(false);
  });
});
