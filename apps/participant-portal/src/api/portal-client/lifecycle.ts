import { portalFetch } from "./fetch";
import type { ProblemLifecycleActionResponse } from "./types";

/**
 * [#2392 Phase 2] local-play on-demand container lifecycle endpoints。 warm local
 * session はカタログ全問を配るが、 container は起動要求があるまで立てない。 stopped の
 * 問題は stackOutputs が空で、 submit / reveal は 409 not_running で拒否される。
 * AWS mode にこの endpoint は存在しない (= `lifecycle` field 不在で UI が呼ばない)。
 */

/**
 * `POST /portal/me/problems/{problemId}/start`。 200 で `{status:"running"}`。
 * container が上がらないときは 502 `start_failed` (= `PortalNetworkError` として
 * throw され、 UI は失敗を隠さず表示する)。
 */
export async function startProblem(
  apiBaseUrl: string,
  teamLoginKey: string,
  problemId: string,
  signal?: AbortSignal,
): Promise<ProblemLifecycleActionResponse> {
  return (await portalFetch<ProblemLifecycleActionResponse>(
    apiBaseUrl,
    `portal/me/problems/${encodeURIComponent(problemId)}/start`,
    teamLoginKey,
    {
      method: "POST",
      signal,
    },
  )) as ProblemLifecycleActionResponse;
}

/**
 * `POST /portal/me/problems/{problemId}/stop`。 200 で `{status:"stopped"}`。
 * container と port slot を解放する (idempotent)。
 */
export async function stopProblem(
  apiBaseUrl: string,
  teamLoginKey: string,
  problemId: string,
  signal?: AbortSignal,
): Promise<ProblemLifecycleActionResponse> {
  return (await portalFetch<ProblemLifecycleActionResponse>(
    apiBaseUrl,
    `portal/me/problems/${encodeURIComponent(problemId)}/stop`,
    teamLoginKey,
    {
      method: "POST",
      signal,
    },
  )) as ProblemLifecycleActionResponse;
}
