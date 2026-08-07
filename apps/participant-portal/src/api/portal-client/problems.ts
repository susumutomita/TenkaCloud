import type { ProblemCatalogEntry } from "@tenkacloud/portal-contracts";
import { portalFetch } from "./fetch";
import type { BattleAttacksResponse, DeployLogsResponse } from "./types";

/**
 * [#2925 / #2926] `GET /portal/problem-catalog` — the participant-facing problem catalog,
 * served by the local control plane from the `problems/` clone it bind-mounts.
 *
 * Only local mode calls this. In AWS mode the portal keeps its build-time catalog, which is
 * built from a submodule checkout that is present at image-build time there. The Docker
 * local image deliberately excludes `problems/` (it must serve the participant's own clone),
 * so its build-time glob is empty and this is the only source.
 *
 * Entries arrive already projected through `metadataToEntry` on the server, so the
 * spoiler-bearing `description` and non-`publicHint` phases/disruptions never cross the wire.
 */
export async function getProblemCatalog(
  apiBaseUrl: string,
  teamLoginKey: string,
  options: { signal?: AbortSignal } = {},
): Promise<readonly ProblemCatalogEntry[]> {
  const response = (await portalFetch<{ entries?: readonly ProblemCatalogEntry[] }>(
    apiBaseUrl,
    "portal/problem-catalog",
    teamLoginKey,
    { ...(options.signal ? { signal: options.signal } : {}) },
  )) as { entries?: readonly ProblemCatalogEntry[] };
  return response.entries ?? [];
}

/**
 * 1 problem に閉じた inspection / telemetry endpoints。
 *   - getDeployLogs: deploy runtime の CloudWatch Logs を nextToken で増分取得
 *   - getBattleAttacks: 自 team の指定 deployment における attack-detected event 時系列
 *
 * `team.ts` は「自チーム全体」 の cross-cut。 こちらは「1 problem に焦点を当てた」 view。
 */

/**
 * Issue #1120: deploy 中の CodeBuild / CloudWatch Logs を nextToken で増分取得する。
 * `/portal/me` の synthetic deployLog は初期表示用で、本 endpoint は terminal の live
 * tailing 用に使う。limit は backend 側で 1-100 に制限される。
 */
export async function getDeployLogs(
  apiBaseUrl: string,
  teamLoginKey: string,
  jobId: string,
  options: { nextToken?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<DeployLogsResponse> {
  const query: Record<string, string> = { jobId };
  if (options.nextToken !== undefined) query.nextToken = options.nextToken;
  if (options.limit !== undefined) query.limit = String(options.limit);
  return (await portalFetch<DeployLogsResponse>(apiBaseUrl, "portal/me/deploy-logs", teamLoginKey, {
    query,
    throwOn400: true,
    signal: options.signal,
  })) as DeployLogsResponse;
}

/**
 * `GET /portal/me/battle-attacks?jobId=&sinceMin=` を `Authorization: Bearer <teamLoginKey>`
 * で呼ぶ。直近 sinceMin (default 30、上限 60) 分内の attack-detected event を時系列降順
 * で返す。invalid_jobid / invalid_sincemin / not_found は `PortalValidationError` で throw。
 */
export async function getBattleAttacks(
  apiBaseUrl: string,
  teamLoginKey: string,
  jobId: string,
  sinceMin?: number,
  signal?: AbortSignal,
): Promise<BattleAttacksResponse> {
  const query: Record<string, string> = { jobId };
  if (sinceMin !== undefined) query.sinceMin = String(sinceMin);
  return (await portalFetch<BattleAttacksResponse>(
    apiBaseUrl,
    "portal/me/battle-attacks",
    teamLoginKey,
    { query, throwOn400: true, signal },
  )) as BattleAttacksResponse;
}
