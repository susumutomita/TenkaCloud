import type { ApiRequest, ApiResponse, HostingService } from "../service";

export const PROBLEM_ID = "crypto-battle";
/** The host's session-signing key in benchmark and test databases; never an organizer login. */
export const HOST_KEY = "bench-host-key";

export interface CreatedTeam {
  readonly teamId: string;
  readonly internalSlug: string;
  readonly teamLoginKey: string;
}
export interface CreatedEvent {
  readonly eventId: string;
  readonly teams: readonly CreatedTeam[];
}

export function apiRequest(
  fields: Pick<ApiRequest, "method" | "path" | "token"> & Partial<ApiRequest>,
): ApiRequest {
  return { query: new URLSearchParams(), body: {}, ...fields };
}

async function expectOk(promise: Promise<ApiResponse>, context: string): Promise<ApiResponse> {
  const response = await promise;
  if (response.status >= 300)
    throw new Error(
      `${context} failed with ${String(response.status)}: ${JSON.stringify(response.body)}`,
    );
  return response;
}

/**
 * Sign in with the organizer key, as the local host does. A store that already has a key gets a
 * rotated one, because only its hash is stored; rotation revokes earlier organizer sessions.
 */
export async function loginAdmin(service: HostingService): Promise<string> {
  const key =
    service.store.ensureLocalOrganizerKey().key ?? service.store.rotateLocalOrganizerKey();
  const response = await expectOk(
    service.admin(apiRequest({ method: "POST", path: "/host/login", token: "", body: { key } })),
    "organizer login",
  );
  const body = response.body as { idToken: string };
  return body.idToken;
}

async function createEvent(
  service: HostingService,
  adminToken: string,
  teamCount: number,
): Promise<CreatedEvent> {
  const teams = Array.from({ length: teamCount }, (_unused, index) => ({
    internalSlug: `team-${String(index + 1).padStart(2, "0")}`,
  }));
  const response = await expectOk(
    service.admin(
      apiRequest({
        method: "POST",
        path: "/events",
        token: adminToken,
        body: { name: `bench-${String(teamCount)}`, teams, problems: [{ problemId: PROBLEM_ID }] },
      }),
    ),
    "create event",
  );
  return response.body as CreatedEvent;
}

/** Creates the event, deploys the Battle, starts it, and readies every team. */
export async function setupMatch(
  service: HostingService,
  teamCount: number,
): Promise<CreatedEvent> {
  const adminToken = await loginAdmin(service);
  const created = await createEvent(service, adminToken, teamCount);
  await expectOk(
    service.admin(
      apiRequest({ method: "POST", path: `/events/${created.eventId}/deploy`, token: adminToken }),
    ),
    "deploy",
  );
  await service.drain();
  await expectOk(
    service.admin(
      apiRequest({
        method: "PATCH",
        path: `/events/${created.eventId}/schedule`,
        token: adminToken,
        body: { startNow: true },
      }),
    ),
    "schedule",
  );
  for (const team of created.teams)
    await expectOk(
      service.participant(
        apiRequest({
          method: "POST",
          path: "/portal/me/coordination/op",
          token: team.teamLoginKey,
          body: { op: { kind: "ready" } },
        }),
      ),
      `ready:${team.teamId}`,
    );
  return created;
}
