import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

/**
 * Issue #1341 (#1335 Phase 3): S3 audit archive (= Object Lock immutable) からの export 経路。
 *
 * Source of truth は DDB の audit table (= 365 日 TTL) で、 短期 read は既存 CSV export
 * (`/admin/insight/audit/export`) で十分。 本 module は **長期 (7-year SOC2 / finance)** に
 * 残った行を、 監査人が遡って読むための JSONL export を担当する (= immutable bucket 経由)。
 *
 * Object layout (audit-archive-writer.ts と対応):
 *   audit/year=YYYY/month=MM/day=DD/<ISOstamp>-<rand>.jsonl
 *
 * Behavior:
 *   - `from` (= YYYY-MM-DD inclusive) / `to` (= YYYY-MM-DD inclusive) で日付 partition を絞る
 *   - 該当 partition の全 object を ListObjectsV2 → 各 GetObject で JSONL bytes を concat
 *   - 累積 size が `MAX_EXPORT_BYTES` (= 100MB) を超えたら truncated=true で打ち切る
 *   - JSONL を 1 文字列で返す (= Lambda の memory に乗る範囲、 100MB は memorySize 256MB 余裕で乗る)
 */

export const MAX_EXPORT_BYTES = 100 * 1024 * 1024; // 100MB chunk cap (SOC2 + Lambda memory headroom)

export interface AuditExportS3Deps {
  readonly s3: Pick<S3Client, "send">;
  readonly bucketName: string;
}

const defaultS3 = new S3Client({});

/**
 * Issue #1341: `index.ts` (= handler routing) が直接 SDK client を import すると
 * `handler-no-direct-sdk-import` harness rule に触れるため、 service module 側で client を
 * encapsulate する。 routing 側は本 builder の戻り値だけを扱う。
 */
export function buildDefaultS3ExportDeps(bucketName: string): AuditExportS3Deps {
  return { s3: defaultS3, bucketName };
}

export interface AuditExportRange {
  /** ISO date YYYY-MM-DD (inclusive). */
  readonly from: string;
  /** ISO date YYYY-MM-DD (inclusive). */
  readonly to: string;
}

export interface AuditExportResult {
  readonly body: string;
  readonly objectCount: number;
  readonly bytes: number;
  readonly truncated: boolean;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime());
}

/**
 * Enumerate the day partitions between `from` and `to` (inclusive, UTC).
 *
 * 単純 loop で 1 日ずつ進める。 SOC2 export horizon は典型 30 日 ~ 1 年なので最大 365 反復、
 * Lambda 内で 1ms 以下のコストに収まる。
 */
export function dayPartitions(range: AuditExportRange): string[] {
  if (!isValidDate(range.from) || !isValidDate(range.to)) return [];
  const start = new Date(`${range.from}T00:00:00Z`);
  const end = new Date(`${range.to}T00:00:00Z`);
  if (start.getTime() > end.getTime()) return [];
  const out: string[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86400_000) {
    const d = new Date(t);
    const y = d.getUTCFullYear().toString().padStart(4, "0");
    const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
    const day = d.getUTCDate().toString().padStart(2, "0");
    out.push(`audit/year=${y}/month=${m}/day=${day}/`);
  }
  return out;
}

async function listObjectKeys(deps: AuditExportS3Deps, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const out = await deps.s3.send(
      new ListObjectsV2Command({
        Bucket: deps.bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of out.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

async function readObjectAsString(deps: AuditExportS3Deps, key: string): Promise<string> {
  const out = await deps.s3.send(new GetObjectCommand({ Bucket: deps.bucketName, Key: key }));
  const body = out.Body;
  if (!body) return "";
  // Body has helper transformToString() on Lambda Node 20 runtime; the optional
  // chain keeps the surface unit-testable with a plain { transformToString } mock.
  const asString = body as { transformToString?: () => Promise<string> };
  if (asString.transformToString) return asString.transformToString();
  return "";
}

/**
 * Streams JSONL objects in `[from, to]` partitions and returns the concatenated body.
 *
 * 100MB cap で truncate する (= response が Lambda 6MB payload に乗らないので、 caller は
 * Content-Disposition で attachment にして large-body Function URL 経路で返す前提)。
 * 段階的 multi-part streaming は MVP-1 では over-engineering、 1 chunk per request に倒す。
 */
export async function exportAuditArchive(
  deps: AuditExportS3Deps,
  range: AuditExportRange,
): Promise<AuditExportResult> {
  const partitions = dayPartitions(range);
  let body = "";
  let bytes = 0;
  let objectCount = 0;
  let truncated = false;
  for (const prefix of partitions) {
    const keys = await listObjectKeys(deps, prefix);
    for (const key of keys) {
      const content = await readObjectAsString(deps, key);
      const contentBytes = Buffer.byteLength(content, "utf-8");
      if (bytes + contentBytes > MAX_EXPORT_BYTES) {
        truncated = true;
        return { body, objectCount, bytes, truncated };
      }
      body += content;
      bytes += contentBytes;
      objectCount += 1;
    }
  }
  return { body, objectCount, bytes, truncated };
}
