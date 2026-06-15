import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";

const TENANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const UsageTenantIdSchema = z.string().regex(TENANT_ID_RE);
export const UsageDaySchema = z.string().regex(DAY_RE).refine(isValidDay, {
  message: "Invalid calendar day",
});

const OccurredAtSchema = z.string().datetime();

export const DeployCompletedUsageDetailSchema = z.object({
  tenantId: UsageTenantIdSchema,
  jobId: z.string().min(1).max(128),
  occurredAt: OccurredAtSchema.optional(),
});

export const ScoreUpdatedUsageDetailSchema = z.object({
  tenantId: UsageTenantIdSchema,
  tickId: z.string().min(1).max(128).optional(),
  jobId: z.string().min(1).max(128).optional(),
  eventId: z.string().min(1).max(128).optional(),
  scoreEventCount: z.number().int().nonnegative().default(1),
  occurredAt: OccurredAtSchema.optional(),
});

export const TenantEventCreatedUsageDetailSchema = z.object({
  tenantId: UsageTenantIdSchema,
  eventId: z.string().min(1).max(128),
  occurredAt: OccurredAtSchema.optional(),
});

export const UsageMeteringEventSchema = z.discriminatedUnion("detail-type", [
  z.object({
    "detail-type": z.literal("DeployCompleted"),
    time: OccurredAtSchema.optional(),
    detail: DeployCompletedUsageDetailSchema,
  }),
  z.object({
    "detail-type": z.literal("ScoreUpdated"),
    time: OccurredAtSchema.optional(),
    detail: ScoreUpdatedUsageDetailSchema,
  }),
  z.object({
    "detail-type": z.literal("TenantEventCreated"),
    time: OccurredAtSchema.optional(),
    detail: TenantEventCreatedUsageDetailSchema,
  }),
]);

export type UsageMeteringEvent = z.infer<typeof UsageMeteringEventSchema>;

export interface UsageCounters {
  readonly deployCompletedCount?: number;
  readonly scoringTickCount?: number;
  readonly scoreEventCount?: number;
  readonly tenantEventCount?: number;
  readonly usageEventCount?: number;
}

export interface RecordUsageFactInput {
  readonly tenantId: string;
  readonly day: string;
  readonly detailType: UsageMeteringEvent["detail-type"];
  readonly idempotencyKey: string;
  readonly counters: UsageCounters;
  readonly occurredAt: string;
}

export interface UsageFactDeps {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
}

export interface UsageDayFact {
  readonly day: string;
  readonly deployCompletedCount: number;
  readonly scoringTickCount: number;
  readonly scoreEventCount: number;
  readonly tenantEventCount: number;
  readonly usageEventCount: number;
}

export interface UsageTenantFacts {
  readonly tenantId: string;
  readonly days: readonly UsageDayFact[];
  readonly totals: UsageDayFact;
}

export interface ListUsageFactsInput {
  readonly tenantIds: readonly string[];
  readonly from: string;
  readonly to: string;
}

export interface ListUsageFactsResponse {
  readonly items: readonly UsageTenantFacts[];
}

const COUNTER_KEYS = [
  "deployCompletedCount",
  "scoringTickCount",
  "scoreEventCount",
  "tenantEventCount",
  "usageEventCount",
] as const satisfies readonly (keyof UsageCounters)[];

function isValidDay(value: string): boolean {
  if (!DAY_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dayOf(occurredAt: string): string {
  return new Date(occurredAt).toISOString().slice(0, 10);
}

function counterValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeCounters(counters: UsageCounters): Required<UsageCounters> {
  const usageEventCount =
    typeof counters.usageEventCount === "number" && counters.usageEventCount > 0
      ? counters.usageEventCount
      : 1;
  return {
    deployCompletedCount: counters.deployCompletedCount ?? 0,
    scoringTickCount: counters.scoringTickCount ?? 0,
    scoreEventCount: counters.scoreEventCount ?? 0,
    tenantEventCount: counters.tenantEventCount ?? 0,
    usageEventCount,
  };
}

function idempotencyKeyFor(event: UsageMeteringEvent, occurredAt: string): string {
  if (event["detail-type"] === "DeployCompleted") return `deploy:${event.detail.jobId}`;
  if (event["detail-type"] === "TenantEventCreated") return `event:${event.detail.eventId}`;
  const id =
    event.detail.tickId ??
    event.detail.jobId ??
    event.detail.eventId ??
    `${event.detail.tenantId}:${occurredAt}`;
  return `score:${id}`;
}

export function usageFactFromEvent(event: UsageMeteringEvent): RecordUsageFactInput {
  const occurredAt = event.detail.occurredAt ?? event.time ?? new Date().toISOString();
  if (event["detail-type"] === "DeployCompleted") {
    return {
      tenantId: event.detail.tenantId,
      day: dayOf(occurredAt),
      detailType: event["detail-type"],
      idempotencyKey: idempotencyKeyFor(event, occurredAt),
      counters: { deployCompletedCount: 1 },
      occurredAt,
    };
  }
  if (event["detail-type"] === "TenantEventCreated") {
    return {
      tenantId: event.detail.tenantId,
      day: dayOf(occurredAt),
      detailType: event["detail-type"],
      idempotencyKey: idempotencyKeyFor(event, occurredAt),
      counters: { tenantEventCount: 1 },
      occurredAt,
    };
  }
  return {
    tenantId: event.detail.tenantId,
    day: dayOf(occurredAt),
    detailType: event["detail-type"],
    idempotencyKey: idempotencyKeyFor(event, occurredAt),
    counters: {
      scoringTickCount: 1,
      scoreEventCount: event.detail.scoreEventCount,
    },
    occurredAt,
  };
}

function isDuplicateTransaction(err: unknown): boolean {
  return err instanceof Error && err.name === "TransactionCanceledException";
}

export async function recordUsageFact(
  deps: UsageFactDeps,
  input: RecordUsageFactInput,
): Promise<{ readonly recorded: boolean }> {
  const parsedTenantId = UsageTenantIdSchema.parse(input.tenantId);
  const parsedDay = UsageDaySchema.parse(input.day);
  const counters = normalizeCounters(input.counters);
  const names: Record<string, string> = { "#day": "day" };
  const values: Record<string, unknown> = {
    ":tenantId": parsedTenantId,
    ":day": parsedDay,
    ":now": input.occurredAt,
  };
  const addParts: string[] = [];
  for (const key of COUNTER_KEYS) {
    const value = counters[key];
    if (value === 0) continue;
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    addParts.push(`#${key} :${key}`);
  }

  try {
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: deps.tableName,
              Item: {
                PK: `TENANT#${parsedTenantId}`,
                SK: `EVENT#${input.idempotencyKey}`,
                tenantId: parsedTenantId,
                detailType: input.detailType,
                day: parsedDay,
                occurredAt: input.occurredAt,
                createdAt: input.occurredAt,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Update: {
              TableName: deps.tableName,
              Key: { PK: `TENANT#${parsedTenantId}`, SK: `DAY#${parsedDay}` },
              UpdateExpression: `SET tenantId = :tenantId, #day = :day, updatedAt = :now ADD ${addParts.join(", ")}`,
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
            },
          },
        ],
      }),
    );
    return { recorded: true };
  } catch (err) {
    if (isDuplicateTransaction(err)) return { recorded: false };
    throw err;
  }
}

function toUsageDayFact(item: Record<string, unknown>): UsageDayFact {
  const rawDay = typeof item.day === "string" ? item.day : String(item.SK ?? "").slice(4);
  return {
    day: rawDay,
    deployCompletedCount: counterValue(item.deployCompletedCount),
    scoringTickCount: counterValue(item.scoringTickCount),
    scoreEventCount: counterValue(item.scoreEventCount),
    tenantEventCount: counterValue(item.tenantEventCount),
    usageEventCount: counterValue(item.usageEventCount),
  };
}

function emptyTotals(): UsageDayFact {
  return {
    day: "TOTAL",
    deployCompletedCount: 0,
    scoringTickCount: 0,
    scoreEventCount: 0,
    tenantEventCount: 0,
    usageEventCount: 0,
  };
}

function addTotals(total: UsageDayFact, day: UsageDayFact): UsageDayFact {
  return {
    day: "TOTAL",
    deployCompletedCount: total.deployCompletedCount + day.deployCompletedCount,
    scoringTickCount: total.scoringTickCount + day.scoringTickCount,
    scoreEventCount: total.scoreEventCount + day.scoreEventCount,
    tenantEventCount: total.tenantEventCount + day.tenantEventCount,
    usageEventCount: total.usageEventCount + day.usageEventCount,
  };
}

async function listTenantUsageFacts(
  deps: UsageFactDeps,
  tenantId: string,
  from: string,
  to: string,
): Promise<UsageTenantFacts> {
  const days: UsageDayFact[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await deps.ddb.send(
      new QueryCommand({
        TableName: deps.tableName,
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :from AND :to",
        ExpressionAttributeValues: {
          ":pk": `TENANT#${tenantId}`,
          ":from": `DAY#${from}`,
          ":to": `DAY#${to}`,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    days.push(...(out.Items ?? []).map((item) => toUsageDayFact(item)));
    exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  return {
    tenantId,
    days,
    totals: days.reduce(addTotals, emptyTotals()),
  };
}

export async function listUsageFacts(
  deps: UsageFactDeps,
  input: ListUsageFactsInput,
): Promise<ListUsageFactsResponse> {
  const from = UsageDaySchema.parse(input.from);
  const to = UsageDaySchema.parse(input.to);
  const seen = new Set<string>();
  const tenantIds: string[] = [];
  for (const tenantId of input.tenantIds) {
    const parsed = UsageTenantIdSchema.parse(tenantId);
    if (seen.has(parsed)) continue;
    seen.add(parsed);
    tenantIds.push(parsed);
  }
  const items = await Promise.all(
    tenantIds.map((tenantId) => listTenantUsageFacts(deps, tenantId, from, to)),
  );
  return { items };
}

export async function handleUsageMeteringEvent(
  deps: UsageFactDeps,
  raw: unknown,
): Promise<{ readonly recorded: boolean; readonly statusCode: number }> {
  const event = UsageMeteringEventSchema.parse(raw);
  const result = await recordUsageFact(deps, usageFactFromEvent(event));
  return { ...result, statusCode: StatusCodes.OK };
}
