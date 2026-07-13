import { PortalNetworkError } from "./errors";
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

/** Reset a simulated-cloud world from its reviewed catalog artifact. */
export async function resetProblem(
  apiBaseUrl: string,
  teamLoginKey: string,
  problemId: string,
  signal?: AbortSignal,
): Promise<ProblemLifecycleActionResponse> {
  return (await portalFetch<ProblemLifecycleActionResponse>(
    apiBaseUrl,
    `portal/me/problems/${encodeURIComponent(problemId)}/reset`,
    teamLoginKey,
    { method: "POST", signal },
  )) as ProblemLifecycleActionResponse;
}

interface ConsoleHandoffResponse {
  readonly handoffPath: string;
}

/**
 * Exchange the authenticated portal session for a short-lived, one-time browser handoff.
 * The authenticated response deliberately contains no Simulator launch token; only the
 * subsequent top-level navigation receives it in a no-store redirect.
 */
export async function issueProblemConsoleHandoff(
  apiBaseUrl: string,
  teamLoginKey: string,
  problemId: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = (await portalFetch<ConsoleHandoffResponse>(
    apiBaseUrl,
    `portal/me/problems/${encodeURIComponent(problemId)}/console-handoff`,
    teamLoginKey,
    { method: "POST", signal },
  )) as ConsoleHandoffResponse;
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const expected = new URL(`portal/me/problems/${encodeURIComponent(problemId)}/console`, base);
  const handoff = new URL(response.handoffPath, base);
  if (
    handoff.origin !== expected.origin ||
    handoff.pathname !== expected.pathname ||
    handoff.username ||
    handoff.password ||
    handoff.hash ||
    handoff.searchParams.size !== 1 ||
    !handoff.searchParams.get("ticket")
  ) {
    throw new PortalNetworkError(502, "invalid_console_handoff");
  }
  return handoff.toString();
}
