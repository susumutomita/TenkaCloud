import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../helper-functions.js";
import type { ScoreEventItem } from "../../problem-deploy/handlers/shared/score-event.js";

export interface RuntimeScoreArchiveEvent {
  readonly eventId?: string;
}

export interface RuntimeScoreArchiveDependencies {
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly s3: Pick<S3Client, "send">;
  readonly now?: () => Date;
}

export interface RuntimeScoreArchiveConfig {
  readonly deploymentsTableName: string;
  readonly archiveBucketName: string;
}

export interface RuntimeScoreArchiveResult {
  readonly eventId: string;
  readonly eventCount: number;
  readonly manifestKey: string;
  readonly partKeys: readonly string[];
}

/**
 * Export raw per-tick score-event rows to bounded JSONL objects.
 *
 * Each DynamoDB scan page is at most 1 MiB, so the Lambda never accumulates a whole event in
 * memory. A `latest.json` manifest is written only after every part succeeds; consumers never see
 * a partial run as current.
 */
export async function archiveRuntimeScoreEvents(
  event: RuntimeScoreArchiveEvent,
  config: RuntimeScoreArchiveConfig,
  dependencies: RuntimeScoreArchiveDependencies,
): Promise<RuntimeScoreArchiveResult> {
  const eventId = requiredEventId(event);
  const archivedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const runId = archivedAt.replaceAll(/[-:.]/gu, "");
  const runPrefix = `events/${eventId}/score-events/runs/${runId}`;
  const partKeys: string[] = [];
  let eventCount = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const page = await dependencies.ddb.send(
      new ScanCommand({
        TableName: config.deploymentsTableName,
        FilterExpression: "eventId = :eventId AND begins_with(SK, :scoreEventPrefix)",
        ExpressionAttributeValues: {
          ":eventId": eventId,
          ":scoreEventPrefix": "EVENT#",
        },
        ConsistentRead: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    const rows = (page.Items ?? [])
      .filter((item): item is ScoreEventItem => isScoreEventForEvent(item, eventId))
      .map((item) => JSON.stringify(item));
    if (rows.length > 0) {
      const partKey = `${runPrefix}/part-${String(partKeys.length + 1).padStart(6, "0")}.jsonl`;
      await dependencies.s3.send(
        new PutObjectCommand({
          Bucket: config.archiveBucketName,
          Key: partKey,
          Body: `${rows.join("\n")}\n`,
          ContentType: "application/x-ndjson",
        }),
      );
      partKeys.push(partKey);
      eventCount += rows.length;
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);

  const manifestKey = `events/${eventId}/score-events/latest.json`;
  await dependencies.s3.send(
    new PutObjectCommand({
      Bucket: config.archiveBucketName,
      Key: manifestKey,
      Body: JSON.stringify({
        formatVersion: 1,
        eventId,
        archivedAt,
        eventCount,
        partKeys,
      }),
      ContentType: "application/json",
    }),
  );
  return { eventId, eventCount, manifestKey, partKeys };
}

export async function handler(event: RuntimeScoreArchiveEvent): Promise<RuntimeScoreArchiveResult> {
  return archiveRuntimeScoreEvents(
    event,
    {
      deploymentsTableName: getEnv("DEPLOYMENTS_TABLE_NAME"),
      archiveBucketName: getEnv("SCORE_ARCHIVE_BUCKET_NAME"),
    },
    {
      ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      s3: new S3Client({}),
    },
  );
}

function requiredEventId(event: RuntimeScoreArchiveEvent): string {
  const eventId = event.eventId?.trim();
  if (!eventId) throw new Error("eventId is required to archive runtime score events");
  return eventId;
}

function isScoreEventForEvent(
  item: Record<string, unknown>,
  eventId: string,
): item is Record<string, unknown> & ScoreEventItem {
  return (
    item.eventId === eventId &&
    typeof item.PK === "string" &&
    typeof item.SK === "string" &&
    item.SK.startsWith("EVENT#") &&
    typeof item.jobId === "string" &&
    typeof item.problemId === "string" &&
    typeof item.source === "string" &&
    typeof item.points === "number" &&
    typeof item.result === "string" &&
    typeof item.occurredAt === "string" &&
    typeof item.expiresAt === "number"
  );
}
