import type { Page } from "playwright-core";

export const REHEARSAL_ORGANIZER = {
  username: "rehearsal-admin",
  // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- Test-only account in a fresh local host data directory.
  password: "local rehearsal password 2026",
} as const;

interface HostAddress {
  admin: string;
  key: string;
}

interface OrganizerCredentials {
  username: string;
  password: string;
}

export async function signInOrganizer(
  page: Page,
  host: HostAddress,
  credentials: OrganizerCredentials = REHEARSAL_ORGANIZER,
): Promise<void> {
  await page.goto(`${host.admin}/events`);
  await page.locator("#organizer-username").waitFor();
  const firstVisit = await page.locator("#local-host-key").isVisible();
  if (firstVisit) await page.locator("#local-host-key").fill(host.key);
  await page.locator("#organizer-username").fill(credentials.username);
  await page.locator("#organizer-password").fill(credentials.password);
  await page.getByRole("button", { name: firstVisit ? "Create Admin account" : "Sign in" }).click();
  await page.getByText("Local competition mode").first().waitFor();
}

export async function organizerToken(
  host: HostAddress,
  credentials: OrganizerCredentials = REHEARSAL_ORGANIZER,
): Promise<string> {
  const status = await fetch(`${host.admin}/api/host/bootstrap-status`);
  if (!status.ok) throw new Error(`Host bootstrap status failed with HTTP ${status.status}.`);
  const state: unknown = await status.json();
  if (
    !state ||
    typeof state !== "object" ||
    !("bootstrapCompleted" in state) ||
    typeof state.bootstrapCompleted !== "boolean"
  )
    throw new Error("Host bootstrap status response is invalid.");
  const firstVisit = !state.bootstrapCompleted;
  const response = await fetch(
    `${host.admin}/api${firstVisit ? "/host/bootstrap" : "/host/login"}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(firstVisit ? { key: host.key } : {}),
        username: credentials.username,
        password: credentials.password,
      }),
    },
  );
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
