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

  // TransactWrite は 100 items が AWS の上限。teams.max(100) + event 1 = 最大 101 で
  // 上限を超えるが、検証で teams を <= 99 に絞るより、teams を <= 100 にして event を
  // 別 PutCommand で先に書く方針は採らない (atomicity を優先)。
  // → Schema で teams.max(100) としているが、実際は 99 がワーカブル上限。安全側に寄せて
  //   teams.max(99) にする方針もあるが、Phase 1 はまず TransactWrite 上限ギリギリで動かし、
  //   Phase 2 (Distributed Map) で chunk 化する。
  if (teams.length + 1 > 100) {
    // 上限の早期チェック (TransactWrite が ValidationException を返すのを待たず明示的に)
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
