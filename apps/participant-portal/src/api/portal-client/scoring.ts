import { portalFetch } from "./fetch";
import type { RevealHintResponse, SubmitFlagOutcome } from "./types";

/**
 * Scoring 系 endpoints (= flag 提出 / progressive hint reveal)。 どちらも 409 で
 * `PortalScoringGateError` (= scoring_not_started / scoring_ended / scoring_locked) に倒れ、
 * UI が lock screen を出す。 400 は `PortalValidationError` (= invalid_flag 等)。
 */

/**
 * Issue #742 Phase 4: progressive hint reveal API。
 * `POST /portal/me/problems/{problemId}/hints/{hintId}/reveal`。
 * 同 hintId 重複 reveal は idempotent (= 200 で kind=already_revealed)。
 */
export async function revealHint(
  apiBaseUrl: string,
  teamLoginKey: string,
  problemId: string,
  hintId: string,
  signal?: AbortSignal,
): Promise<RevealHintResponse> {
  return (await portalFetch<RevealHintResponse>(
    apiBaseUrl,
    `portal/me/problems/${encodeURIComponent(problemId)}/hints/${encodeURIComponent(hintId)}/reveal`,
    teamLoginKey,
    {
      method: "POST",
      throwOn400: true,
      // Issue #1006: 409 scoring_not_started / scoring_ended / scoring_locked を
      // PortalScoringGateError として throw (= UI が startsAt 文言を出せる)。
      throwOn409: true,
      signal,
    },
  )) as RevealHintResponse;
}

/**
 * Phase 2c: Flag 提出は `problemId` 必須に。`POST /portal/me/submit-flag { problemId, flag }`。
 */
export async function submitFlag(
  apiBaseUrl: string,
  teamLoginKey: string,
  problemId: string,
  flag: string,
  signal?: AbortSignal,
): Promise<SubmitFlagOutcome> {
  return (await portalFetch<SubmitFlagOutcome>(apiBaseUrl, "portal/me/submit-flag", teamLoginKey, {
    method: "POST",
    body: { problemId, flag },
    throwOn400: true,
    // Issue #1006: 409 scoring_not_started / scoring_ended / scoring_locked を
    // PortalScoringGateError として throw (= UI が startsAt 文言を出せる)。
    throwOn409: true,
    signal,
  })) as SubmitFlagOutcome;
}
