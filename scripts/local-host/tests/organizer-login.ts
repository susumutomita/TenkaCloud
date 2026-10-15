// Legacy account-mode fixtures still exercise the historical account/role boundary.
export const REHEARSAL_ORGANIZER = {
  username: "rehearsal-admin",
  // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- Test-only account in a fresh local host data directory.
  password: "local rehearsal password 2026",
} as const;

interface HostAddress {
  admin: string;
  key: string;
}

export async function organizerToken(host: HostAddress): Promise<string> {
  const response = await fetch(`${host.admin}/api/host/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: host.key }),
  });
  const payload: unknown = await response.json();
  if (
    !response.ok ||
    !payload ||
    typeof payload !== "object" ||
    !("idToken" in payload) ||
    typeof payload.idToken !== "string"
  )
    throw new Error(`Organizer sign-in failed with HTTP ${response.status}.`);
  return payload.idToken;
}
