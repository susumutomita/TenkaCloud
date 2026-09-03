import { ulid } from "ulid";
import {
  computeCatalogSnapshotId,
  type PinnedProblemProvenance,
} from "../../../problem-pack/event-pin.js";
import type { EventRecord } from "../../control-data/events-repository.js";
import type { TeamRecord } from "../../control-data/teams-repository.js";
import { generateTeamLoginKey } from "../deploy-handler/team-key.js";
import { warnOnCoordinationCapacity } from "./coordination-capacity-warning.js";
import { type EventSharedResources, resolveEventRepositories } from "./shared.js";
import type { CreateEventRequest, CreateEventResponse } from "./types.js";

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
 * Event 1 行 + Teams N 行を **原子的に書く** (repository seam の `createEventWithTeams`)。
 *
 * 失敗セマンティクス: 書き込みは all-or-nothing なので、teamLoginKey の重複等で
 * 1 件でも失敗したら全行が書かれない。caller は呼び直しで OK (eventId は ULID なので
 * idempotent ではない、新規生成する)。
 *
 * `teams` の internalSlug 重複と `problems` の problemId 重複は **caller 側で validate**
 * すべきだが、defense-in-depth で本関数でもチェックする (ConditionalCheckFailed より分かりやすい)。
 *
 * [#2437 Phase A2] DDB TransactWrite (event 1 + teams ≤99、 全行 attribute_not_exists) は
 * repository seam に移設。 一意性違反は seam が `conflict` union に変換して返すので、
 * 本 handler は throw に戻して従来どおり 500 経路に載せる (ULID 衝突は実質起こらない)。
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

  // teamLoginKey を required に保った型で持つ (TeamRecord 上は optional): 生成漏れを
  // 型エラーにし、 response へ空 key が silent に流れないようにする。
  const teams: Array<TeamRecord & { readonly teamLoginKey: string }> = req.teams.map((t) => ({
    eventId,
    teamId: ulid(),
    tenantId: ctx.tenantId,
    internalSlug: t.internalSlug,
    teamLoginKey: generateTeamLoginKey(),
    awsAccountId: t.awsAccountId,
    nonAwsCredentialTeamSlug: t.nonAwsCredentialTeamSlug,
    createdAt,
    updatedAt: createdAt,
    expiresAt,
  }));

  const eventRecord: EventRecord = {
    eventId,
    tenantId: ctx.tenantId,
    name: req.name,
    status: "DRAFT",
    problems: req.problems,
    teamCount: teams.length,
    createdAt,
    updatedAt: createdAt,
    expiresAt,
    ...buildEventCatalogPin(shared, ctx.tenantId),
  };

  const repositories = await resolveEventRepositories(shared);
  const result = await repositories.events.createEventWithTeams(eventRecord, teams);
  if (result.outcome === "conflict") {
    // attribute_not_exists / 一意性制約の不成立。 ULID 生成なので実質起こらない —
    // 旧実装が TransactionCanceledException をそのまま throw していたのと同じく
    // 500 経路 (handleRouteError) に載せる。
    throw new Error(`createEventWithTeams conflict: event/team row already exists (${eventId})`);
  }

  // [Issue #3169] The event is created either way; this only tells the operator
  // what the deploy will refuse. Blocking here would make an existing event that
  // no longer fits impossible to recreate, and the team roster is the thing they
  // would have to change anyway — better said now, while it is still a draft,
  // than discovered when they press deploy.
  const capacityWarnings = warnOnCoordinationCapacity({
    problems: req.problems,
    teamCount: teams.length,
    problemsCoordination: shared.problemsCoordination,
    budget: shared.runtime.coordinationStateBudget(),
    tenantId: ctx.tenantId,
    eventId,
  });

  return {
    eventId,
    status: eventRecord.status,
    createdAt,
    expiresAt,
    ...(capacityWarnings.length > 0 ? { warnings: capacityWarnings } : {}),
    teams: teams.map((t) => ({
      teamId: t.teamId,
      internalSlug: t.internalSlug,
      teamLoginKey: t.teamLoginKey,
    })),
    problems: req.problems,
  };
}

function buildEventCatalogPin(
  shared: EventSharedResources,
  tenantId: string,
): Pick<EventRecord, "catalogSnapshotId" | "packProvenance"> {
  const problems = buildPinnedProblems(shared);
  const packProvenance = buildPackProvenance(problems);
  if (Object.keys(packProvenance).length === 0) return {};
  return {
    catalogSnapshotId: computeCatalogSnapshotId(tenantId, problems),
    packProvenance,
  };
}

function buildPinnedProblems(shared: EventSharedResources): readonly PinnedProblemProvenance[] {
  return Object.keys(shared.problemsCatalog)
    .sort((a, b) => a.localeCompare(b))
    .map((problemId) => ({
      problemId,
      provenance: shared.problemsProvenance[problemId] ?? { source: "core" },
    }));
}

function buildPackProvenance(
  problems: readonly PinnedProblemProvenance[],
): NonNullable<EventRecord["packProvenance"]> {
  const packProvenance: NonNullable<EventRecord["packProvenance"]> = {};
  for (const problem of problems) {
    const provenance = problem.provenance;
    if (provenance.source !== "pack") continue;
    packProvenance[problem.problemId] = {
      packId: provenance.packId,
      packVersion: provenance.packVersion,
      contentDigest: provenance.contentDigest,
    };
  }
  return packProvenance;
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
