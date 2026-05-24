import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { warnDeployTrace } from "../../shared/trace-log.js";
import type { EventSharedResources } from "../shared.js";
import type { BulkDeployRequest, EventItem, EventProblemTarget, TeamItem } from "../types.js";
import type { LoadedBulkDeployTargets, SelectedBulkDeployTargets } from "./types.js";

/**
 * Event 行と Teams を 1 round-trip 並列で取得し、Event の `problems` 配列とともに返す。
 * `tenantId` mismatch / event 不在は `undefined` (= not_found)。
 */
export async function loadBulkDeployTargets(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
): Promise<LoadedBulkDeployTargets | undefined> {
  const [eventOut, teamsOut] = await Promise.all([
    shared.ddb.send(
      new GetCommand({
        TableName: shared.eventsTableName,
        Key: { PK: `EVENT#${eventId}`, SK: "META" },
      }),
    ),
    shared.ddb.send(
      new QueryCommand({
        TableName: shared.teamsTableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :tprefix)",
        ExpressionAttributeValues: { ":pk": `EVENT#${eventId}`, ":tprefix": "TEAM#" },
      }),
    ),
  ]);
  const event = eventOut.Item as Partial<EventItem> | undefined;
  if (!event || event.tenantId !== tenantId) return undefined;
  return {
    event,
    allTeams: (teamsOut.Items ?? []) as TeamItem[],
    allProblems: (Array.isArray(event.problems) ? event.problems : []) as EventProblemTarget[],
  };
}

/**
 * `request.teamIds` / `request.problemIds` で範囲を絞る (= 後追い team / 問題用)。
 * 絞った結果 0 件になった場合は `undefined` を返し、caller は空 result を返す。
 */
export function selectBulkDeployTargets(
  eventId: string,
  tenantId: string,
  loaded: LoadedBulkDeployTargets,
  request: BulkDeployRequest | undefined,
): SelectedBulkDeployTargets | undefined {
  const teamIdFilter = request?.teamIds ? new Set(request.teamIds) : undefined;
  const problemIdFilter = request?.problemIds ? new Set(request.problemIds) : undefined;
  const teams = teamIdFilter
    ? loaded.allTeams.filter((team) => teamIdFilter.has(team.teamId))
    : loaded.allTeams;
  const problems = problemIdFilter
    ? loaded.allProblems.filter((problem) => problemIdFilter.has(problem.problemId))
    : loaded.allProblems;
  if (teams.length > 0 && problems.length > 0) return { teams, problems };
  warnDeployTrace("bulk-deploy.skip.filter_eliminated_all", {
    correlationId: eventId,
    tenantId,
    allTeamsCount: loaded.allTeams.length,
    filteredTeamsCount: teams.length,
    allProblemsCount: loaded.allProblems.length,
    filteredProblemsCount: problems.length,
    hasTeamIdFilter: teamIdFilter !== undefined,
    hasProblemIdFilter: problemIdFilter !== undefined,
  });
  return undefined;
}
