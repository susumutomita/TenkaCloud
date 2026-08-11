import { portalFetch } from "./fetch";
import type { ParticipantEndpointsResponse } from "./types";

/**
 * Endpoint registry CRUD (= 1 problem の slot 単位で default URL を
 * 競技者が override / 解除する)。 list は GET、 override 登録は POST、 削除は DELETE。
 * 400 (invalid_url 等) と 409 (slot_not_overridable) は `PortalValidationError` で
 * inline form エラーとして表示する。
 */

/**
 * 1 problem の slot 一覧 (= default URL + override URL + effective URL の集約 view)。
 * 競技者 portal で「自チームの endpoint」 panel を render するために使う。
 */
export async function listProblemEndpoints(
  apiBaseUrl: string,
  teamLoginKey: string,
  problemId: string,
  signal?: AbortSignal,
): Promise<ParticipantEndpointsResponse> {
  return (await portalFetch<ParticipantEndpointsResponse>(
    apiBaseUrl,
    `portal/me/problems/${encodeURIComponent(problemId)}/endpoints`,
    teamLoginKey,
    { signal, throwOn400: true },
  )) as ParticipantEndpointsResponse;
}

/**
 * 競技者が override URL を登録 / 更新する (`POST .../endpoints/<slot> { url }`)。 400 (invalid_url
 * など) と 409 (slot_not_overridable) は PortalValidationError に変換し、 caller (= form) が
 * inline error として表示する。
 */
export async function putProblemEndpointOverride(
  apiBaseUrl: string,
  teamLoginKey: string,
  problemId: string,
  slot: string,
  url: string,
  signal?: AbortSignal,
): Promise<ParticipantEndpointsResponse> {
  return (await portalFetch<ParticipantEndpointsResponse>(
    apiBaseUrl,
    `portal/me/problems/${encodeURIComponent(problemId)}/endpoints/${encodeURIComponent(slot)}`,
    teamLoginKey,
    { method: "POST", body: { url }, throwOn400: true, throwOn409: true, signal },
  )) as ParticipantEndpointsResponse;
}

/** override を解除して default URL に戻す。 */
export async function deleteProblemEndpointOverride(
  apiBaseUrl: string,
  teamLoginKey: string,
  problemId: string,
  slot: string,
  signal?: AbortSignal,
): Promise<ParticipantEndpointsResponse> {
  return (await portalFetch<ParticipantEndpointsResponse>(
    apiBaseUrl,
    `portal/me/problems/${encodeURIComponent(problemId)}/endpoints/${encodeURIComponent(slot)}`,
    teamLoginKey,
    // Issue #2283: locked 問題への delete も 409 challenge_prerequisite_not_met で拒否される
    // ため throwOn409 を opt-in (= PortalValidationError → inline の親切文言に変換)。
    { method: "DELETE", throwOn400: true, throwOn409: true, signal },
  )) as ParticipantEndpointsResponse;
}
