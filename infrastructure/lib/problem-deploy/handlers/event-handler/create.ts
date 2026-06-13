import { TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { generateTeamLoginKey } from "../deploy-handler/team-key.js";
import type { EventSharedResources } from "./shared.js";
import type { CreateEventRequest, CreateEventResponse, EventItem, TeamItem } from "./types.js";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 日

const toEpochSeconds = (ms: number): number => Math.floor(ms / 1000);

export interface CreateEventContext {
  readonly tenantId: string;
  readonly nowMs: number;
  readonly ttlMs?: number;
}

export class DuplicateInternalSlugError extends Error {
  constructor(public readonly slug: string) {
    super(`duplicate internalSlug in request: ${slug}`);
    this.name = "DuplicateInternalSlugError";
  }
}

export class DuplicateProblemIdError extends Error {
  constructor(public readonly problemId: string) {
    super(`duplicate problemId in request: ${problemId}`);
    this.name = "DuplicateProblemIdError";
  }
}

/**
 * Event 1 行 + Teams N 行を **TransactWrite で原子的に書く**。
 *
 * 失敗セマンティクス: TransactWrite は all-or-nothing なので、teamLoginKey の重複等で
 * 1 件でも失敗したら全行が書かれない。caller は呼び直しで OK (eventId は ULID なので
 * idempotent ではない、新規生成する)。
 *
 * `teams` の internalSlug 重複と `problems` の problemId 重複は **caller 側で validate**
 * すべきだが、defense-in-depth で本関数でもチェックする (ConditionalCheckFailed より分かりやすい)。
 */
export async function createEvent(
  shared: EventSharedResources,
  ctx: CreateEventContext,
  req: CreateEventRequest,
): Promise<CreateEventResponse> {
  validateNoDuplicateSlugs(req);
  validateNoDuplicateProblems(req);

  const eventId = ulid();
  const nowMs = ctx.nowMs;
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = toEpochSeconds(nowMs + (ctx.ttlMs ?? DEFAULT_TTL_MS));

  const teams = req.teams.map((t) => {
    const teamId = ulid();
    const teamLoginKey = generateTeamLoginKey();
    const item: TeamItem = {
      PK: `EVENT#${eventId}`,
      SK: `TEAM#${teamId}`,
      GSI1PK: `TENANT#${ctx.tenantId}`,
      GSI1SK: `EVENT#${eventId}#TEAM#${teamId}`,
      GSI2PK: `TEAMKEY#${teamLoginKey}`,
      GSI2SK: "META",
      eventId,
      teamId,
      tenantId: ctx.tenantId,
      internalSlug: t.internalSlug,
      teamLoginKey,
      awsAccountId: t.awsAccountId,
      createdAt,
      updatedAt: createdAt,
      expiresAt,
    };
    return item;
  });

  const eventItem: EventItem = {
    PK: `EVENT#${eventId}`,
    SK: "META",
    GSI1PK: `TENANT#${ctx.tenantId}`,
    GSI1SK: createdAt,
    eventId,
    tenantId: ctx.tenantId,
    name: req.name,
    status: "DRAFT",
    problems: req.problems,
    teamCount: teams.length,
    createdAt,
    updatedAt: createdAt,
    expiresAt,
  };

  // TransactWrite は 100 items が AWS の上限。event 1 行 + teams を 1 つの atomic write で書くため
  // teams は最大 99 (= 100 - event 1 行)。 schema (CreateEventRequestSchema) を teams.max(99) に
  // 揃えたので、 検証を通った request はここに到達した時点で必ず teams <= 99。 100+ teams への対応は
  // atomicity を犠牲にしないため Phase 2 (Distributed Map で chunk 化) に回す。
  // 下記は schema を迂回した呼び出しに対する defense-in-depth (validated path では発火しない)。
  if (teams.length + 1 > 100) {
    throw new Error(`TransactWrite items > 100 (teams=${teams.length} + event=1)`);
  }

  const transact: TransactWriteCommandInput = {
    TransactItems: [
      {
        Put: {
          TableName: shared.eventsTableName,
          Item: eventItem,
          // 同一 eventId 二重生成防止 (実質起こらないが defense-in-depth)
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      ...teams.map((t) => ({
        Put: {
          TableName: shared.teamsTableName,
          Item: t,
          ConditionExpression: "attribute_not_exists(PK)",
        },
      })),
    ],
  };
  await shared.ddb.send(new TransactWriteCommand(transact));

  return {
    eventId,
    status: eventItem.status,
    createdAt,
    expiresAt,
    teams: teams.map((t) => ({
      teamId: t.teamId,
      internalSlug: t.internalSlug,
      teamLoginKey: t.teamLoginKey,
    })),
    problems: req.problems,
  };
}

function validateNoDuplicateSlugs(req: CreateEventRequest): void {
  const seen = new Set<string>();
  for (const team of req.teams) {
    if (seen.has(team.internalSlug)) {
      throw new DuplicateInternalSlugError(team.internalSlug);
    }
    seen.add(team.internalSlug);
  }
}

function validateNoDuplicateProblems(req: CreateEventRequest): void {
  const seen = new Set<string>();
  for (const p of req.problems) {
    if (seen.has(p.problemId)) {
      throw new DuplicateProblemIdError(p.problemId);
    }
    seen.add(p.problemId);
  }
}
