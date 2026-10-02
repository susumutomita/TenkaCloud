import type { Page } from "playwright-core";

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

/** Playwright's fill errors can include their argument; never log an organizer secret. */
export async function fillOrganizerKey(page: Page, key: string): Promise<void> {
  try {
    await page.locator("#local-host-key").fill(key);
  } catch {
    throw new Error("Could not enter the organizer key in the login form.");
  }
}

export async function signInOrganizer(page: Page, host: HostAddress): Promise<void> {
  await page.goto(`${host.admin}/events`);
  await fillOrganizerKey(page, host.key);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("Local competition mode").first().waitFor();
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
