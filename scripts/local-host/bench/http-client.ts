/** Thin fetch wrapper matching the real portal/host-console request shape (see
 * scripts/local-host/tests/coordination-http.test.ts for the reference contract). */
export interface HttpCall {
  readonly status: number;
}

export async function apiCall(
  origin: string,
  path: string,
  method: string,
  token: string,
  body?: unknown,
): Promise<HttpCall> {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Fully drain the body so the underlying socket is reusable under concurrent load.
  await response.text();
  return { status: response.status };
}

export async function expectOk(call: Promise<HttpCall>, context: string): Promise<HttpCall> {
  const result = await call;
  if (result.status >= 300) throw new Error(`${context} failed with HTTP ${String(result.status)}`);
  return result;
}

export interface CreatedTeam {
  readonly teamId: string;
  readonly internalSlug: string;
  readonly teamLoginKey: string;
}
export interface CreatedEvent {
  readonly eventId: string;
  readonly teams: readonly CreatedTeam[];
}

export async function adminLogin(origin: string, key: string): Promise<string> {
  const response = await fetch(`${origin}/api/host/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (response.status >= 300)
    throw new Error(`Host login failed with HTTP ${String(response.status)}`);
  const body = (await response.json()) as { idToken: string };
  return body.idToken;
}

export async function createEvent(
  origin: string,
  adminToken: string,
  teamCount: number,
  problemId: string,
): Promise<CreatedEvent> {
  const teams = Array.from({ length: teamCount }, (_unused, index) => ({
    internalSlug: `team-${String(index + 1).padStart(2, "0")}`,
  }));
  const response = await fetch(`${origin}/api/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name: `bench-${String(teamCount)}`, teams, problems: [{ problemId }] }),
  });
  if (response.status !== 201)
    throw new Error(`Create event failed with HTTP ${String(response.status)}`);
  return (await response.json()) as CreatedEvent;
}

export async function eventStatus(
  origin: string,
  adminToken: string,
  eventId: string,
): Promise<string> {
  const response = await fetch(`${origin}/api/events/${eventId}`, {
    method: "GET",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (response.status >= 300)
    throw new Error(`Event detail failed with HTTP ${String(response.status)}`);
  const body = (await response.json()) as { status: string };
  return body.status;
}

export async function waitForReady(
  origin: string,
  adminToken: string,
  eventId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await eventStatus(origin, adminToken, eventId);
    if (status === "READY") return;
    if (Date.now() > deadline) throw new Error(`Event ${eventId} did not become READY in time.`);
    await new Promise((accept) => setTimeout(accept, 250));
  }
}
