import type { CompetitionNetworkView } from "@tenkacloud/portal-contracts";
import { portalFetch } from "./fetch";

export function getCompetitionNetwork(
  apiBaseUrl: string,
  teamLoginKey: string,
  problemId: string,
  signal?: AbortSignal,
) {
  return portalFetch<CompetitionNetworkView>(
    apiBaseUrl,
    `portal/me/problems/${encodeURIComponent(problemId)}/network`,
    teamLoginKey,
    { method: "GET", throwOn400: true, throwOn409: true, signal },
  );
}
export function publishCompetitionService(
  apiBaseUrl: string,
  teamLoginKey: string,
  problemId: string,
  serviceId: string,
  published: boolean,
) {
  return portalFetch<CompetitionNetworkView>(
    apiBaseUrl,
    `portal/me/problems/${encodeURIComponent(problemId)}/network`,
    teamLoginKey,
    { method: "POST", body: { serviceId, published }, throwOn400: true, throwOn409: true },
  );
}

export function openPublishedWeb(
  apiBaseUrl: string,
  teamLoginKey: string,
  ownProblemId: string,
  target: { teamId: string; problemId: string; serviceId: string },
) {
  return portalFetch<{ url: string; expiresInMs: number }>(
    apiBaseUrl,
    `portal/me/problems/${encodeURIComponent(ownProblemId)}/public-web-handoff`,
    teamLoginKey,
    { method: "POST", body: target, throwOn400: true, throwOn409: true },
  );
}
