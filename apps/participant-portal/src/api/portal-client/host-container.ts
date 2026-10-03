import { portalFetch } from "./fetch";

/** Host-owned state-preserving controls. The caller cannot select a job, service or URL. */
export async function changeHostContainer(
  apiBaseUrl: string,
  teamLoginKey: string,
  problemId: string,
  action: "start" | "stop",
): Promise<void> {
  await portalFetch(
    apiBaseUrl,
    `portal/me/problems/${encodeURIComponent(problemId)}/container/${action}`,
    teamLoginKey,
    { method: "POST", body: {}, throwOn400: true, throwOn409: true },
  );
}
