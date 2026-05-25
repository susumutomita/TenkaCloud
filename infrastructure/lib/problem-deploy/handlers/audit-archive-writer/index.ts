import type { AttributeValue, DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { buildDefaultS3ArchiveClient, type S3ArchiveClient } from "./s3-archive.js";

/**
 * Issue #1341 (#1335 Phase 3): AdminAuditLog DynamoDB Stream → S3 immutable archive。
 *
 * DDB Stream に流れる INSERT event を JSONL に変換して S3 へ append-only に
 * PutObject する。 S3 bucket は Object Lock (= compliance mode, 1-year retention) で
 * 立てるため、 書込後 1 年間は admin / root でも上書き / 削除できない (= SOC2 CC6 immutability)。
 *
 * Object key layout: `audit/year=YYYY/month=MM/day=DD/<ISOtimestamp>-<ulid>.jsonl`
 *   - Hive 様 partition なので Athena / S3 Select で日付 prune が効く
 *   - 1 stream record = 1 PutObject (= MVP-1、 1 op/日 ≒ 30 PutObject/月 の予測で free tier 圧迫なし)
 *
 * fail-safe: stream record の 1 件が writes に失敗しても他 record を継続処理する。
 *   Lambda が throw すると DDB Stream は最大 24h 再 deliver を試みるため、 catch して swallow
 *   ([[feedback-question-premise-before-patching]] writeAuditEvent と同方針)。
 *
 * env:
 *   - `AUDIT_ARCHIVE_BUCKET_NAME` 必須。 空文字なら no-op で 0 record success を返す (= 旧 stack 互換)
 */

const FALLBACK_KEY_RANDOM_LEN = 8;

interface ArchivedAuditRow {
  readonly PK: string;
  readonly SK: string;
  readonly actor?: string;
  readonly actorUsername?: string;
  readonly action?: string;
  readonly outcome?: string;
  readonly target?: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly occurredAt?: string;
  readonly extra?: Record<string, unknown>;
}

export interface ArchiveDeps {
  readonly s3: S3ArchiveClient;
  readonly bucketName: string;
  readonly now?: () => Date;
}

function getEnv(): { bucketName: string } | undefined {
  const bucketName = process.env.AUDIT_ARCHIVE_BUCKET_NAME ?? "";
  if (bucketName.length === 0) return undefined;
  return { bucketName };
}

export function buildObjectKey(occurredAt: Date, ulidSuffix: string): string {
  const year = occurredAt.getUTCFullYear().toString().padStart(4, "0");
  const month = (occurredAt.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = occurredAt.getUTCDate().toString().padStart(2, "0");
  const isoStamp = occurredAt.toISOString().replace(/[:.]/g, "-");
  return `audit/year=${year}/month=${month}/day=${day}/${isoStamp}-${ulidSuffix}.jsonl`;
}

function randomSuffix(): string {
  // Lambda runtime is single-threaded per invoke; Math.random is acceptable for an
  // archive-key tiebreaker (= no security implications, just collision avoidance when
  // multiple stream records share the same ms timestamp).
  return Math.random()
    .toString(36)
    .slice(2, 2 + FALLBACK_KEY_RANDOM_LEN);
}

/**
 * Issue #1341: DDB stream の AttributeValue を JS value に最小限で unmarshall する。
 * audit row は string / map / number しか含まないので minimal mapper で十分
 * (= 外部 dep `@aws-sdk/util-dynamodb` を増やさず Lambda bundle を抑える)。
 *
 * Each scalar type lives in a separate helper so the dispatcher stays under biome's
 * cognitive-complexity cap (= avoids stacking branches in one function).
 */
function scalarFromAv(av: AttributeValue): unknown {
  if ("S" in av && typeof av.S === "string") return av.S;
  if ("N" in av && typeof av.N === "string") return Number(av.N);
  if ("BOOL" in av && typeof av.BOOL === "boolean") return av.BOOL;
  if ("NULL" in av && av.NULL === true) return null;
  return undefined;
}

function mapFromAv(av: AttributeValue): unknown {
  if (!("M" in av) || !av.M) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(av.M)) out[k] = fromAttributeValue(v);
  return out;
}

function collectionFromAv(av: AttributeValue): unknown {
  if ("L" in av && Array.isArray(av.L)) return av.L.map(fromAttributeValue);
  if ("SS" in av && Array.isArray(av.SS)) return av.SS.slice();
  if ("NS" in av && Array.isArray(av.NS)) return av.NS.map((n) => Number(n));
  return undefined;
}

function fromAttributeValue(av: AttributeValue): unknown {
  const scalar = scalarFromAv(av);
  if (scalar !== undefined) return scalar;
  const map = mapFromAv(av);
  if (map !== undefined) return map;
  return collectionFromAv(av);
}

function unmarshallImage(image: Record<string, AttributeValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(image)) {
    const value = fromAttributeValue(v);
    if (value !== undefined) out[k] = value;
  }
  return out;
}

const OPTIONAL_STRING_FIELDS = [
  "actor",
  "actorUsername",
  "action",
  "outcome",
  "target",
  "ipAddress",
  "userAgent",
  "occurredAt",
] as const;

function pickOptionalStrings(item: Record<string, unknown>): Partial<ArchivedAuditRow> {
  const out: Record<string, string> = {};
  for (const field of OPTIONAL_STRING_FIELDS) {
    const value = item[field];
    if (typeof value === "string") out[field] = value;
  }
  return out as Partial<ArchivedAuditRow>;
}

/**
 * Issue #1341: 1 stream record → 1 ArchivedAuditRow に正規化する。
 * INSERT 以外 (= MODIFY / REMOVE) は audit append-only 性質上 skip (= TTL expiry の REMOVE が混じる)。
 */
export function recordToRow(record: DynamoDBRecord): ArchivedAuditRow | null {
  if (record.eventName !== "INSERT") return null;
  const image = record.dynamodb?.NewImage;
  if (!image) return null;
  const item = unmarshallImage(image as Record<string, AttributeValue>);
  const pk = typeof item.PK === "string" ? item.PK : "";
  const sk = typeof item.SK === "string" ? item.SK : "";
  if (!pk || !sk) return null;
  const extra =
    item.extra && typeof item.extra === "object" && !Array.isArray(item.extra)
      ? (item.extra as Record<string, unknown>)
      : undefined;
  return {
    PK: pk,
    SK: sk,
    ...pickOptionalStrings(item),
    ...(extra ? { extra } : {}),
  };
}

export async function archiveRecord(
  record: DynamoDBRecord,
  deps: ArchiveDeps,
): Promise<{ archived: boolean; key?: string }> {
  const row = recordToRow(record);
  if (!row) return { archived: false };
  const occurredAt = row.occurredAt ? new Date(row.occurredAt) : (deps.now?.() ?? new Date());
  const key = buildObjectKey(occurredAt, randomSuffix());
  const body = `${JSON.stringify(row)}\n`;
  await deps.s3.putObject({
    bucket: deps.bucketName,
    key,
    body,
    contentType: "application/x-ndjson",
  });
  return { archived: true, key };
}

export async function handler(event: DynamoDBStreamEvent): Promise<{ archived: number }> {
  const cfg = getEnv();
  if (!cfg) {
    console.warn("[audit-archive] AUDIT_ARCHIVE_BUCKET_NAME 未設定、 skipping");
    return { archived: 0 };
  }
  const deps: ArchiveDeps = { s3: buildDefaultS3ArchiveClient(), bucketName: cfg.bucketName };
  let archived = 0;
  for (const record of event.Records) {
    try {
      const out = await archiveRecord(record, deps);
      if (out.archived) archived += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error("[audit-archive] PutObject failed (swallowed)", {
        eventID: record.eventID,
        message,
      });
    }
  }
  return { archived };
}
