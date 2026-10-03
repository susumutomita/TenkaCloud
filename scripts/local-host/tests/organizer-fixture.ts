import { apiRequest } from "../bench/state-setup";
import type { HostingService } from "../service";
import type { OrganizerRole } from "../store";

// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- A disposable local-host test account.
export const TEST_ORGANIZER_PASSWORD = "organizer fixture password 2026";

function idToken(body: unknown): string {
  if (!body || typeof body !== "object" || !("idToken" in body) || typeof body.idToken !== "string")
    throw new Error("Organizer session did not contain an id token.");
  return body.idToken;
}

export async function bootstrapOrganizer(
  service: HostingService,
  key: string,
  username = "fixture-admin",
): Promise<string> {
  const response = await service.admin(
    apiRequest({
      method: "POST",
      path: "/host/bootstrap",
      token: "",
      body: { key, username, password: TEST_ORGANIZER_PASSWORD },
    }),
  );
  if (response.status !== 201) throw new Error("Organizer bootstrap failed.");
  return idToken(response.body);
}

export async function createOrganizerSession(
  service: HostingService,
  adminToken: string,
  username: string,
  role: OrganizerRole,
): Promise<{ token: string; refresh: string }> {
  const created = await service.admin(
    apiRequest({
      method: "POST",
      path: "/host/users",
      token: adminToken,
      body: { username, role, password: TEST_ORGANIZER_PASSWORD },
    }),
  );
  if (created.status !== 201) throw new Error("Organizer creation failed.");
  const loggedIn = await service.admin(
    apiRequest({
      method: "POST",
      path: "/host/login",
      token: "",
      body: { username, password: TEST_ORGANIZER_PASSWORD },
    }),
  );
  const body = loggedIn.body;
  if (
    !body ||
    typeof body !== "object" ||
    !("refreshToken" in body) ||
    typeof body.refreshToken !== "string"
  )
    throw new Error("Organizer session did not contain a refresh token.");
  return { token: idToken(body), refresh: body.refreshToken };
}
